import { describe, it, expect } from 'vitest';

/**
 * Guard for the rule the audit of PR #1258 turned up: in `lib/loan-history.ts`
 * an **empty list is a claim about the ledger**, not a neutral default.
 *
 * `deriveLoanPaymentHistory` reads an empty `interestTransactions` as "no
 * interest was booked against these payments, so their interest is zero" -- a
 * measured zero that reaches Interest Paid, every cumulative total, the CSV and
 * PDF exports and the projection seed. A `catch` in this module that answers
 * with `[]` (or `0`, or a bare default) turns a timeout, a 500 or a proxy error
 * into exactly that claim, and the user has no way to tell the two apart.
 *
 * So this module does not catch: every failure propagates to the caller, which
 * owns an error-and-retry state (`useReportData` in the three loan reports,
 * `failedAccountId` in `useLoanProjection`, the page-level error on the account
 * detail route). The scan is the whole rule -- there is no legitimate `catch`
 * here, so no baseline to keep.
 */
const sources = import.meta.glob('/src/lib/loan-history.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** A `catch` clause, with or without a bound error, and `.catch(` on a promise. */
const CATCH = /(^|[^.\w])catch\s*(\([^)]*\))?\s*\{|\.catch\s*\(/;

describe('loan-history.ts lets a failed lookup fail', () => {
  it('is the one module this project ships, and it contains no catch', () => {
    // Sanity: the glob resolved to the module (an empty match set would make
    // every assertion below vacuously true).
    expect(Object.keys(sources)).toEqual(['/src/lib/loan-history.ts']);
  });

  it('never converts a rejected fetch into an empty ledger', () => {
    const [path, content] = Object.entries(sources)[0];
    const offendingLines = content
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => CATCH.test(line))
      .map(({ line, number }) => `${path}:${number}: ${line.trim()}`);

    expect(
      offendingLines,
      'A failed interest or transaction lookup must reject, not resolve to an ' +
        'empty list: an empty list is what tells deriveLoanPaymentHistory that ' +
        'these payments booked no interest. Let the rejection reach the caller ' +
        "and render its error-and-retry state instead of the loan's numbers.",
    ).toEqual([]);
  });
});
