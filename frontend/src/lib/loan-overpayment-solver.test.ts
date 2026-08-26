import { describe, it, expect } from 'vitest';
import {
  LoanScheduleInput,
  calculateMortgagePaymentAmount,
  generateLoanSchedule,
} from './loan-schedule';
import {
  solveRecurringForInterestSavings,
  solveRecurringForPayoffMonth,
  solveRecurringForTargetInterest,
} from './loan-overpayment-solver';

function baseInput(overrides: Partial<LoanScheduleInput> = {}): LoanScheduleInput {
  return {
    startingBalance: 100000,
    annualRate: 5,
    paymentAmount: 600,
    frequency: 'MONTHLY',
    firstPaymentDate: new Date('2025-01-15'),
    ...overrides,
  };
}

const baseline = generateLoanSchedule(baseInput());

describe('solveRecurringForTargetInterest', () => {
  it('finds a recurring extra that brings total interest at or below a reachable target', () => {
    const target = baseline.totalInterest / 2;
    const solved = solveRecurringForTargetInterest(baseInput(), target);

    expect(solved.status).toBe('ok');
    expect(solved.amount).toBeGreaterThan(0);
    expect(solved.result!.totalInterest).toBeLessThanOrEqual(target + 0.5);
    // Smallest such amount: one step less overshoots the target.
    expect(solved.result!.totalInterest).toBeGreaterThan(target - baseline.totalInterest * 0.05);
  });

  it('returns already-met (0 extra) when the loan already costs at most the target', () => {
    const solved = solveRecurringForTargetInterest(baseInput(), baseline.totalInterest + 1000);
    expect(solved.status).toBe('already-met');
    expect(solved.amount).toBe(0);
  });

  it('returns unreachable when even the maximum extra cannot get interest that low', () => {
    const solved = solveRecurringForTargetInterest(baseInput(), 1);
    expect(solved.status).toBe('unreachable');
    expect(solved.amount).toBeNull();
    expect(solved.interestSaved).toBeNull();
  });
});

describe('solveRecurringForInterestSavings', () => {
  it('finds a recurring extra that saves at least the target vs the baseline', () => {
    const target = baseline.totalInterest / 2;
    const solved = solveRecurringForInterestSavings(baseInput(), target);

    expect(solved.status).toBe('ok');
    expect(solved.amount).toBeGreaterThan(0);
    expect(solved.interestSaved).toBeGreaterThanOrEqual(target - 0.5);
    // The savings reported are the baseline-vs-result difference.
    expect(solved.interestSaved).toBeCloseTo(
      baseline.totalInterest - solved.result!.totalInterest,
      2,
    );
  });

  it('returns already-met for a zero savings target', () => {
    const solved = solveRecurringForInterestSavings(baseInput(), 0);
    expect(solved.status).toBe('already-met');
    expect(solved.amount).toBe(0);
    expect(solved.interestSaved).toBe(0);
  });

  it('returns unreachable when the savings asked for exceed the total interest', () => {
    const solved = solveRecurringForInterestSavings(baseInput(), baseline.totalInterest);
    expect(solved.status).toBe('unreachable');
    expect(solved.amount).toBeNull();
  });
});

describe('solveRecurringForPayoffMonth', () => {
  it('finds a recurring extra that pays the loan off by a reachable target month', () => {
    // Baseline pays off years out; ask to be done ~3 years after the first payment.
    const target = '2028-01';
    const solved = solveRecurringForPayoffMonth(baseInput(), target);

    expect(solved.status).toBe('ok');
    expect(solved.amount).toBeGreaterThan(0);
    expect(solved.result!.payoffDate!.slice(0, 7) <= target).toBe(true);
  });

  it('returns already-met when the loan already pays off by the target month', () => {
    const solved = solveRecurringForPayoffMonth(baseInput(), baseline.payoffDate!.slice(0, 7));
    expect(solved.status).toBe('already-met');
    expect(solved.amount).toBe(0);
  });

  it('returns unreachable for a month earlier than the soonest possible payoff', () => {
    const solved = solveRecurringForPayoffMonth(baseInput(), '2024-12');
    expect(solved.status).toBe('unreachable');
    expect(solved.amount).toBeNull();
  });
});

describe('goal-seek under non-monthly loan frequencies', () => {
  // A biweekly loan asked for a monthly overpayment: the cadence ratio does not
  // divide, so the solver and the replay must agree on how many occurrences a
  // year the plan really pays. Under the old rounded interval they did not --
  // the solve assumed 13 hits a year and returned an amount too low for the 12
  // the plan describes.
  const biweekly = (): LoanScheduleInput => ({
    startingBalance: 300000,
    annualRate: 5,
    paymentAmount: calculateMortgagePaymentAmount(
      300000,
      5,
      300,
      'BIWEEKLY',
      false,
      false,
    ),
    frequency: 'BIWEEKLY',
    firstPaymentDate: new Date(2026, 0, 1),
  });

  /** Replay the solved amount through the same cadence the plan carries. */
  const replay = (amount: number) =>
    generateLoanSchedule({
      ...biweekly(),
      overpayments: {
        recurringExtra: { amount, frequency: 'MONTHLY', mode: 'SHORTEN_TERM' },
      },
    });

  it('returns a payoff-month amount that still reaches the target on replay', () => {
    const target = '2042-06';
    const solved = solveRecurringForPayoffMonth(
      biweekly(),
      `${target}-01`,
      'SHORTEN_TERM',
      1,
      { frequency: 'MONTHLY' },
    );
    expect(solved.status).toBe('ok');
    const replayed = replay(solved.amount!);
    expect(replayed.paidOff).toBe(true);
    expect(replayed.payoffDate!.slice(0, 7) <= target).toBe(true);
  });

  it('returns an interest-savings amount that still saves that much on replay', () => {
    const savings = 50000;
    const solved = solveRecurringForInterestSavings(
      biweekly(),
      savings,
      'SHORTEN_TERM',
      1,
      { frequency: 'MONTHLY' },
    );
    expect(solved.status).toBe('ok');
    const baselineBiweekly = generateLoanSchedule(biweekly());
    const replayed = replay(solved.amount!);
    expect(replayed.paidOff).toBe(true);
    expect(baselineBiweekly.totalInterest - replayed.totalInterest).toBeGreaterThanOrEqual(
      savings,
    );
  });
});

describe('a target cannot be met by a truncated schedule', () => {
  // 500k at 6% paying 2510/month never clears inside the 50-year horizon.
  const nonAmortizing = (): LoanScheduleInput => ({
    startingBalance: 500000,
    annualRate: 6,
    paymentAmount: 2510,
    frequency: 'MONTHLY',
    firstPaymentDate: new Date(2026, 0, 15),
  });

  it('reports baseline-incomplete rather than a saving against a subtotal', () => {
    const incomplete = generateLoanSchedule(nonAmortizing());
    expect(incomplete.paidOff).toBe(false);

    const savings = solveRecurringForInterestSavings(nonAmortizing(), 10000);
    expect(savings.status).toBe('baseline-incomplete');
    expect(savings.amount).toBeNull();
    expect(savings.interestSaved).toBeNull();

    // Same for an absolute target: "already met" would be a claim about the
    // horizon's interest, which is smaller than the loan's.
    const target = solveRecurringForTargetInterest(
      nonAmortizing(),
      incomplete.totalInterest + 1,
    );
    expect(target.status).toBe('baseline-incomplete');
  });

  it('never counts a truncated candidate as meeting an interest target', () => {
    // maxPayments caps every candidate schedule, so no amount can prove a
    // lifetime interest below the target -- the answer is unreachable, not a
    // small amount whose truncated interest happens to look low enough.
    const solved = solveRecurringForTargetInterest(
      { ...nonAmortizing(), maxPayments: 12 },
      1,
    );
    expect(solved.status).toBe('baseline-incomplete');
  });
});
