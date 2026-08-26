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

/**
 * Comment *lines* removed, so both the domain test and the hand-rolled-switch
 * test look at code rather than prose.
 *
 * The domain test is a substring match, and a substring match on the whole file
 * is satisfied by a file merely *naming* the other domain: `loan-schedule.ts`
 * documenting that `accounts.payment_frequency` can hold "the
 * scheduled-transaction recurrence's spelling" was pulled into scope and
 * reported as an offender, though its switch is over amortisation cadences the
 * shared module does not model. Explaining a neighbouring domain is not
 * participating in it -- and a `case 'MONTHLY':` inside a comment is not a
 * switch either.
 *
 * Deliberately conservative: only lines whose first non-space characters open a
 * comment are dropped. Stripping from any `//` to end of line would also cut
 * inside string literals and regexes -- `'https://x' // ScheduledTransaction`,
 * or a URL followed by real code -- which would remove a domain token from a
 * file that genuinely belongs in scope and silently stop guarding it. A guard
 * that can quietly narrow its own coverage is worse than none, so the failure
 * direction here is a false positive (a trailing-comment mention keeps a file in
 * scope, and the reviewer sees a name) rather than a false negative.
 */
function stripComments(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

describe('recurrence stepping goes through @/lib/frequency', () => {
  it('has no frequency switch outside the shared module', () => {
    const offenders = productionSources()
      .filter(([path]) => !OWNERS.includes(path))
      .map(([path, content]) => [path, stripComments(content)] as [string, string])
      .filter(([, code]) => SCHEDULED_TRANSACTION_DOMAIN.test(code))
      .filter(([, code]) => CASE_LABEL.test(code))
      .map(([path]) => path);

    // Use advanceByFrequency / isOneTime / monthlyEquivalent instead. A local
    // switch silently omits whichever frequency its author forgot.
    expect(offenders).toEqual([]);
  });

  it('still finds the shared module, so the rule cannot pass by accident', () => {
    const owner = sources['/src/lib/frequency.ts'];
    expect(owner, '/src/lib/frequency.ts not found -- update OWNERS in this test').toBeTruthy();
    // Stripped as the scan strips it, so the owner qualifies on its code.
    const code = stripComments(owner);
    expect(CASE_LABEL.test(code)).toBe(true);
    expect(SCHEDULED_TRANSACTION_DOMAIN.test(code)).toBe(true);
  });

  it('does not pull a file into scope for naming the domain in a comment', () => {
    // The false positive the strip exists for: an amortisation switch in a file
    // whose only mention of scheduled transactions is prose.
    const commentOnly = [
      '      // accounts.payment_frequency can hold the scheduled-transaction',
      "      // recurrence's spelling, so both are accepted here.",
      '      switch (frequency) {',
      "        case 'MONTHLY':",
      '          return 12;',
      '      }',
    ].join('\n');
    const code = stripComments(commentOnly);
    expect(CASE_LABEL.test(code)).toBe(true);
    expect(SCHEDULED_TRANSACTION_DOMAIN.test(code)).toBe(false);

    // And real participation still qualifies: the domain token in code, not a
    // comment, keeps the file in scope.
    const inCode = stripComments(
      [
        "      import type { ScheduledTransaction } from '@/types/scheduled-transaction';",
        '      switch (st.frequency) {',
        "        case 'MONTHLY':",
        '          return 12;',
        '      }',
      ].join('\n'),
    );
    expect(SCHEDULED_TRANSACTION_DOMAIN.test(inCode)).toBe(true);
    expect(CASE_LABEL.test(inCode)).toBe(true);
  });

  it('keeps a file in scope when the domain token sits in code beside a comment', () => {
    // The conservative direction: a trailing comment is NOT stripped, so a line
    // mixing a URL or a string with real code cannot lose its domain token and
    // fall out of the scan.
    const trailing = [
      "      const docs = 'https://example.com'; // see ScheduledTransaction",
      '      switch (frequency) {',
      "        case 'MONTHLY':",
      '          return 12;',
      '      }',
    ].join('\n');
    const code = stripComments(trailing);
    expect(code).toContain('https://example.com');
    expect(SCHEDULED_TRANSACTION_DOMAIN.test(code)).toBe(true);
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
