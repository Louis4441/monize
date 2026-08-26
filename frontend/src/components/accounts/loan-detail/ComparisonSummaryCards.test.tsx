import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ComparisonSummaryCards } from './ComparisonSummaryCards';
import { compareSchedules, generateLoanSchedule } from '@/lib/loan-schedule';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

/**
 * A comparison whose baseline runs past the projection horizon, so no lifetime
 * saving exists: 500k at 6% paying 2510 a month never clears inside 50 years.
 */
function makeIncomparable() {
  const input = {
    startingBalance: 500000,
    annualRate: 6,
    paymentAmount: 2510,
    frequency: 'MONTHLY' as const,
    firstPaymentDate: new Date(2026, 0, 15),
  };
  const baseline = generateLoanSchedule(input);
  const scenario = generateLoanSchedule({
    ...input,
    overpayments: { recurringExtra: { amount: 100, frequency: 'MONTHLY' } },
  });
  return compareSchedules(baseline, scenario);
}

function makeComparison(paymentAmount = 500) {
  const input = {
    startingBalance: 10000,
    annualRate: 6,
    paymentAmount,
    frequency: 'MONTHLY' as const,
    firstPaymentDate: new Date(2026, 0, 15),
  };
  const baseline = generateLoanSchedule(input);
  const scenario = generateLoanSchedule({
    ...input,
    overpayments: { recurringExtra: { amount: 200 } },
  });
  return compareSchedules(baseline, scenario);
}

describe('ComparisonSummaryCards', () => {
  it('shows the scenario payoff date, time saved, and savings', () => {
    const comparison = makeComparison();
    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('New Payoff Date')).toBeInTheDocument();
    expect(screen.getByText('Time Saved')).toBeInTheDocument();
    expect(screen.getByText(`${comparison.monthsSaved} months`)).toBeInTheDocument();
    expect(screen.getByText('Interest Saved')).toBeInTheDocument();
    expect(
      screen.getByText(`$${comparison.interestSaved!.toFixed(2)}`),
    ).toBeInTheDocument();
    expect(screen.getByText('Total Extra Contributed')).toBeInTheDocument();
    expect(
      screen.getByText(`$${comparison.scenario.totalExtraPrincipal.toFixed(2)}`),
    ).toBeInTheDocument();
  });

  it('falls back to payments saved when no whole month is saved', () => {
    const baseline = generateLoanSchedule({
      startingBalance: 1000,
      annualRate: 6,
      paymentAmount: 500,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date(2026, 0, 15),
    });
    const comparison = compareSchedules(baseline, baseline);
    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('0 payments')).toBeInTheDocument();
    // Interest saved and extra contributed are both $0.00
    expect(screen.getAllByText('$0.00')).toHaveLength(2);
  });

  it('labels a scenario that still never pays off', () => {
    const neverPaysOff = generateLoanSchedule({
      startingBalance: 10000,
      annualRate: 60,
      paymentAmount: 100,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date(2026, 0, 15),
    });
    const comparison = compareSchedules(neverPaysOff, neverPaysOff);
    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('Beyond projection')).toBeInTheDocument();
  });

  it('says Unknown rather than 0.00 when the saving cannot be worked out', () => {
    const comparison = makeIncomparable();
    // Both sides of the guard: the schedule really is truncated, and the cards
    // do not print a number for either saving.
    expect(comparison.baseline.paidOff).toBe(false);
    expect(comparison.interestSaved).toBeNull();
    expect(comparison.monthsSaved).toBeNull();

    render(<ComparisonSummaryCards comparison={comparison} currencyCode="CAD" />);

    expect(screen.getByText('Interest Saved')).toBeInTheDocument();
    expect(screen.getByText('Time Saved')).toBeInTheDocument();
    // One "Unknown" for the time saved and one for the interest saved.
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    // And nothing anywhere claiming a zero saving.
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('0 payments')).not.toBeInTheDocument();
    expect(screen.queryByText('0 months')).not.toBeInTheDocument();
  });
});
