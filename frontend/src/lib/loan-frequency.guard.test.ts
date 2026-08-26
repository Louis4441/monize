import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ScheduleFrequency,
  advanceDate,
  getPeriodsPerYear,
  maxPaymentsForHorizon,
} from '@/lib/loan-schedule';
import {
  MORTGAGE_PAYMENT_FREQUENCIES,
  PAYMENT_FREQUENCIES,
} from '@/types/account';
import enAccounts from '@/i18n/messages/en/accounts.json';
import { advanceByFrequency } from '@/lib/frequency';

/**
 * `accounts.payment_frequency` holds whichever spelling wrote it, and two paths
 * write it: the mortgage path stores the mortgage enum's value, the loan-payment
 * setup dialog stores the scheduled-transaction recurrence's. `ScheduleFrequency`
 * has to accept every one of them, because `buildLoanProjectionInput` reaches the
 * engine through a cast (`account.paymentFrequency as ScheduleFrequency`) and
 * `getPeriodsPerYear` answers an unrecognized value with its monthly default.
 *
 * That is what happened to semi-monthly: the dialog stores `SEMIMONTHLY`,
 * `ScheduleFrequency` spelled it `SEMI_MONTHLY`, and the loan detail page, the
 * overpayment simulator, both loan reports and `useLoanProjection` all projected
 * 12 periods a year instead of 24 -- roughly double the remaining interest and a
 * payoff date twice as far out.
 *
 * A cast cannot be type-checked, so this is the scan that checks it: it reads the
 * options out of the setup dialog's source rather than trusting a copy here.
 */
function dialogFrequencies(): string[] {
  const source = readFileSync(
    join(
      __dirname,
      '..',
      'components',
      'accounts',
      'LoanPaymentSetupDialog.tsx',
    ),
    'utf8',
  );
  const values = [...source.matchAll(/\{\s*value:\s*'([A-Z_]+)'/g)].map(
    (m) => m[1],
  );
  if (values.length === 0) {
    throw new Error(
      'LoanPaymentSetupDialog.tsx no longer declares its frequency options as ' +
        "{ value: '...' } literals; update this guard to read whatever offers them now",
    );
  }
  return values;
}

describe('loan payment frequency contract', () => {
  it('reads a non-empty option set out of the setup dialog', () => {
    const offered = dialogFrequencies();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).toContain('MONTHLY');
    // The spelling that used to be missing.
    expect(offered).toContain('SEMIMONTHLY');
  });

  it('gives every offered frequency its own period count', () => {
    // Declared here rather than compared against `frequency.ts`'s
    // OCCURRENCES_PER_YEAR: that table is calendar-average (52.18 weeks a year)
    // for restating amounts, while a payment schedule counts exact periods. Each
    // value is asserted against its own expected count, so a wrong case fails as
    // well as a missing one -- the failure mode is a silent fall-through to 12.
    const expected: Record<string, number> = {
      WEEKLY: 52,
      BIWEEKLY: 26,
      SEMIMONTHLY: 24,
      MONTHLY: 12,
      QUARTERLY: 4,
      YEARLY: 1,
    };
    for (const frequency of dialogFrequencies()) {
      expect(expected[frequency]).toBeDefined();
      expect(getPeriodsPerYear(frequency as ScheduleFrequency)).toBe(
        expected[frequency],
      );
    }
  });

  it('lands a year out after one year of steps, for every frequency', () => {
    // The period count and the date stepping are two halves of one claim, and
    // `advanceDate` has the same monthly default `getPeriodsPerYear` has -- so a
    // frequency it does not recognize dates the rows a month apart however
    // correct its count is. Stepping `periods` times must therefore land about a
    // year out: 52 weekly steps and 26 biweekly ones give 364 days, 24
    // semi-monthly and 12 monthly a little over a calendar year. A monthly
    // fall-through would overshoot wildly (52 months is four and a half years).
    const start = new Date(2026, 0, 1);
    for (const frequency of dialogFrequencies()) {
      const periods = getPeriodsPerYear(frequency as ScheduleFrequency);
      let cursor = start;
      for (let i = 0; i < periods; i++) {
        const next = advanceDate(cursor, frequency as ScheduleFrequency);
        expect(next.getTime()).toBeGreaterThan(cursor.getTime());
        cursor = next;
      }
      const days = Math.round(
        (cursor.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(days).toBeGreaterThanOrEqual(360);
      expect(days).toBeLessThanOrEqual(380);
    }
  });

  it('has a label for every frequency an account can store', () => {
    // The loan detail page builds its label by template from
    // account.paymentFrequency, so a stored value with no catalog key renders the
    // raw key path and next-intl logs MISSING_MESSAGE. The parity suite cannot
    // catch it -- every locale is equally missing a key nobody added -- so the
    // check is here, against the two lists the column can hold.
    const labels = Object.keys(enAccounts.loanDetail.frequency);
    for (const frequency of [
      ...PAYMENT_FREQUENCIES,
      ...MORTGAGE_PAYMENT_FREQUENCIES,
    ]) {
      expect(labels).toContain(frequency);
    }
  });

  it('gives every account-storable frequency a period count', () => {
    // Both lists reach `buildLoanProjectionInput`'s cast, so both must be real
    // cases rather than the monthly default.
    const expected: Record<string, number> = {
      WEEKLY: 52,
      ACCELERATED_WEEKLY: 52,
      BIWEEKLY: 26,
      ACCELERATED_BIWEEKLY: 26,
      SEMIMONTHLY: 24,
      SEMI_MONTHLY: 24,
      MONTHLY: 12,
      QUARTERLY: 4,
      YEARLY: 1,
    };
    for (const frequency of [
      ...PAYMENT_FREQUENCIES,
      ...MORTGAGE_PAYMENT_FREQUENCIES,
    ]) {
      expect(getPeriodsPerYear(frequency as ScheduleFrequency)).toBe(
        expected[frequency],
      );
    }
  });

  it('offers only frequencies the account type list can store', () => {
    // The dialog writes its value onto accounts.payment_frequency, which
    // UpdateAccountDto validates against the same list -- so an option outside it
    // creates an account that cannot be saved again.
    for (const frequency of dialogFrequencies()) {
      expect(PAYMENT_FREQUENCIES as readonly string[]).toContain(frequency);
    }
  });

  it('steps semi-monthly exactly as the recurrence engine does', () => {
    // The projection's row dates and the scheduler's posting dates are the same
    // calendar to a borrower, so they have to be the same calendar in code. The
    // engine's convention is the 15th and the last day of the month; projecting
    // the 1st and the 15th showed dates the register never has.
    //
    // `advanceDate` spells the rule out rather than importing the recurrence
    // module (that import would put loan-schedule.ts in the other guard's
    // domain), so the agreement is asserted here over a couple of years --
    // including the short and leap Februaries, where a clamp is easiest to get
    // wrong.
    for (const spelling of ['SEMI_MONTHLY', 'SEMIMONTHLY'] as ScheduleFrequency[]) {
      let mine = new Date(2026, 0, 1);
      let theirs = new Date(2026, 0, 1);
      for (let i = 0; i < 60; i++) {
        mine = advanceDate(mine, spelling);
        theirs = advanceByFrequency(theirs, 'SEMIMONTHLY');
        expect(mine.getTime()).toBe(theirs.getTime());
      }
      // And it really did move: 60 steps is two and a half years.
      expect(mine.getFullYear()).toBeGreaterThan(2027);
    }

    // A leap February, where "last day" is the 29th.
    let leap = new Date(2028, 1, 10);
    leap = advanceDate(leap, 'SEMIMONTHLY');
    expect(leap.getMonth()).toBe(1);
    expect(leap.getDate()).toBe(29);
  });

  it('treats both spellings of semi-monthly identically', () => {
    // Both are persisted, by different paths, so neither may be the odd one out.
    expect(getPeriodsPerYear('SEMI_MONTHLY')).toBe(24);
    expect(getPeriodsPerYear('SEMIMONTHLY')).toBe(24);
    expect(maxPaymentsForHorizon('SEMIMONTHLY')).toBe(
      maxPaymentsForHorizon('SEMI_MONTHLY'),
    );
    const start = new Date(2026, 0, 1);
    expect(advanceDate(start, 'SEMIMONTHLY').getTime()).toBe(
      advanceDate(start, 'SEMI_MONTHLY').getTime(),
    );
  });
});
