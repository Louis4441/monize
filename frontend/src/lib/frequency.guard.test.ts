import { describe, it, expect } from 'vitest';
import { FREQUENCY_VALUES } from '@/types/scheduled-transaction';
import enScheduledTransactions from '@/i18n/messages/en/scheduledTransactions.json';

/**
 * Guard test for the one-implementation rule on recurrence stepping.
 *
 * Four components each carried their own `switch (frequency)` before task B3
 * (cash-flow forecast, occurrence picker, bills calendar, upcoming-bills
 * report). Two had drifted -- neither handled `SEMIMONTHLY`, so those schedules
 * projected the same date repeatedly -- and every new frequency had to be added
 * in four places. `@/lib/frequency` is now the only file that knows the maths;
 * this test fails if a hand-rolled switch reappears anywhere else.
 *
 * Modelled on `src/test/ui-conventions.test.ts`.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The files allowed to enumerate frequency values. */
const OWNERS = [
  '/src/lib/frequency.ts', // the implementation
  '/src/types/scheduled-transaction.ts', // the value list itself
];

function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/** `case 'MONTHLY':` and friends -- a frequency handled by a hand-rolled switch. */
const CASE_LABEL = new RegExp(`case\\s+['"](${FREQUENCY_VALUES.join('|')})['"]\\s*:`);

/**
 * Loan and mortgage payment cadences (`ScheduleFrequency`,
 * `OverpaymentFrequency` in `loan-schedule.ts`) share literal names such as
 * `MONTHLY` with this enum but are a different domain -- amortisation, not
 * scheduled transactions. Only files working with a scheduled transaction are
 * in scope.
 */
const SCHEDULED_TRANSACTION_DOMAIN = /scheduled-transaction|ScheduledTransaction|FrequencyType/;

describe('recurrence stepping goes through @/lib/frequency', () => {
  it('has no frequency switch outside the shared module', () => {
    const offenders = productionSources()
      .filter(([path]) => !OWNERS.includes(path))
      .filter(([, content]) => SCHEDULED_TRANSACTION_DOMAIN.test(content))
      .filter(([, content]) => CASE_LABEL.test(content))
      .map(([path]) => path);

    // Use advanceByFrequency / isOneTime / monthlyEquivalent instead. A local
    // switch silently omits whichever frequency its author forgot.
    expect(offenders).toEqual([]);
  });

  it('still finds the shared module, so the rule cannot pass by accident', () => {
    const owner = sources['/src/lib/frequency.ts'];
    expect(owner, '/src/lib/frequency.ts not found -- update OWNERS in this test').toBeTruthy();
    expect(CASE_LABEL.test(owner)).toBe(true);
  });

  it('has an English label for every frequency the selector offers', () => {
    // The selector renders t(`frequency.${value}`), so a value with no catalog
    // entry shows as a raw key. The parity suite then carries it to the other
    // locales.
    expect(Object.keys(enScheduledTransactions.frequency).sort()).toEqual(
      [...FREQUENCY_VALUES].sort(),
    );
  });
});
