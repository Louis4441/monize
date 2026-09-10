import { describe, it, expect } from 'vitest';
import { blankComments } from '@/test/blank-comments';

/**
 * Guard for B3: a date or a share count a reader sees in a report goes through
 * the preference seam -- `useDateFormat().formatDate` for the date,
 * `useNumberFormat().formatShareQuantity` for the count.
 *
 * This is the "the fix for one surface is not the fix" shape. One pass migrated
 * `BillPaymentHistoryReport`, `RealizedGainsReport` and
 * `UncategorizedTransactionsReport` onto `formatDate`, and
 * `InvestmentPerformanceReport` / `RealizedGainsReport` off `.toFixed(4)`, and
 * left the investment reports beside them untouched -- so a `de` reader saw
 * `Jan 5, 2026` on one report's table and their own arrangement on the next,
 * and a `decimal(20,4)` share count printed as the raw string `10.0000` with a
 * `.` decimal in every locale. Two scans, one per half:
 *
 *   1. a date-fns `format(...)` call whose pattern names a month by NAME
 *      (`MMM`), which is English here because no locale is ever passed. The
 *      token itself is fine as an argument to `useChartDateFormat()`'s
 *      `formatChartDate`, which localizes the month name -- that is the chart
 *      convention and is deliberately not matched. An ISO pattern
 *      (`yyyy-MM-dd`, `yyyy-MM`) is also not matched: those are machine values
 *      -- query bounds, month keys, CSV cells -- and ISO is what a machine
 *      surface should write.
 *   2. a `.toFixed(...)` rendering a share count, in either of the two forms
 *      this codebase produced it: a receiver that names a quantity at any
 *      precision, and a bare `.toFixed(4)` whatever it is called, because the
 *      alias is how the last one got through.
 *
 * The date scan carries a shrink-only list of reports outside this change that
 * still hold the pattern; its staleness check fails an entry once its file is
 * fixed, so an exemption cannot outlive the defect it records. The quantity
 * scan has no list: after this change, nothing under `src/components/reports/`
 * renders a count that way.
 */

const sources = import.meta.glob('/src/components/reports/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: a test may legitimately spell the pattern it asserts on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/** 1-indexed line number of a character offset, for an offender report. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * A call to the bare `format` (date-fns) whose last argument is a quoted
 * pattern containing `MMM`. The lookbehind is what keeps `formatChartDate(...)`
 * and a `.format(...)` on an `Intl` formatter out: only an identifier that IS
 * `format` counts.
 */
const ENGLISH_MONTH_NAME_FORMAT =
  /(?<![A-Za-z0-9_$.])format\([^()]*(?:\([^()]*\))?[^()]*?(['"])[^'"]*MMM[^'"]*\1\s*\)/g;

/** A `.toFixed(...)` whose receiver names a share count, at any precision. */
const QUANTITY_TO_FIXED = /\b\w*(?:quantity|Quantity|shares|Shares)\w*(?:\s*\))*\s*\.toFixed\(/g;

/** The share-precision fingerprint, whatever the receiver is called. */
const FOUR_DP_TO_FIXED = /\.toFixed\(\s*4\s*\)/g;

/**
 * Reports outside this change that still render an English month name, with
 * what each one is. Delete an entry when its file moves onto `formatDate` (or,
 * for a chart-shaped label, `formatChartDate`); leaving it fails the staleness
 * check below.
 */
const ENGLISH_MONTH_BASELINE: Record<string, string> = {
  '/src/components/reports/DuplicateTransactionReport.tsx':
    "the duplicate-pair table's transaction date on screen; not owned by this change",
  '/src/components/reports/LoanAmortizationReport.tsx':
    'the projected payoff month on screen and in the PDF, and the schedule row date; not owned by this change',
  '/src/components/reports/UpcomingBillsReport.tsx':
    "the calendar's month heading, the PDF subtitle and each bill's due date; not owned by this change",
};

describe('the comment stripper', () => {
  it('blanks a comment while preserving line numbers', () => {
    const stripped = blankComments("const a = 1;\n// format(d, 'MMM d, yyyy') and toFixed(4)\nconst b = 2;");
    expect(stripped).not.toContain('MMM');
    expect(stripped).not.toContain('toFixed');
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('leaves code alone, so a real offender is still found', () => {
    const stripped = blankComments("const d = format(parseLocalDate(x), 'MMM d, yyyy');");
    expect(stripped).toContain("'MMM d, yyyy'");
  });
});

describe("a report's date is the reader's arrangement", () => {
  function offenders(): string[] {
    const found: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (path in ENGLISH_MONTH_BASELINE) continue;
      const content = blankComments(raw);
      for (const match of content.matchAll(ENGLISH_MONTH_NAME_FORMAT)) {
        found.push(`${path}:${lineOf(content, match.index)}`);
      }
    }
    return found;
  }

  it('has no date-fns format with an English month name', () => {
    // Use `useDateFormat().formatDate(value)` for a date in a table, a cell or
    // a PDF; `useChartDateFormat()` with the same token for a chart label.
    expect(offenders()).toEqual([]);
  });

  it('matches the shape it was written for, and not the localizing helper', () => {
    // Positive and negative controls. Without the first, the scan above could
    // pass over a codebase full of offenders; without the second it would fail
    // every chart in the directory and the honest response would be to delete
    // it.
    const offending = "const s = format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy');";
    const legitimate = "const s = formatChartDate(parsed, 'MMM d, yyyy');";
    const machine = "const s = format(parseLocalDate(tx.transactionDate), 'yyyy-MM-dd');";

    ENGLISH_MONTH_NAME_FORMAT.lastIndex = 0;
    expect(ENGLISH_MONTH_NAME_FORMAT.test(offending)).toBe(true);
    ENGLISH_MONTH_NAME_FORMAT.lastIndex = 0;
    expect(ENGLISH_MONTH_NAME_FORMAT.test(legitimate)).toBe(false);
    ENGLISH_MONTH_NAME_FORMAT.lastIndex = 0;
    expect(ENGLISH_MONTH_NAME_FORMAT.test(machine)).toBe(false);
  });

  it('keeps every baselined report honest', () => {
    for (const path of Object.keys(ENGLISH_MONTH_BASELINE)) {
      expect(sources[path], `${path} is baselined but does not exist`).toBeTruthy();
      const content = blankComments(sources[path]);
      ENGLISH_MONTH_NAME_FORMAT.lastIndex = 0;
      expect(
        ENGLISH_MONTH_NAME_FORMAT.test(content),
        `${path} no longer formats an English month name -- delete its baseline entry`,
      ).toBe(true);
    }
  });
});

describe("a report's share count is the reader's number locale", () => {
  it('renders no quantity through toFixed', () => {
    // A `Set`: the two patterns overlap on the commonest offender
    // (`quantity.toFixed(4)`), and one line reported twice reads as two defects.
    const found = new Set<string>();
    for (const [path, raw] of productionSources()) {
      const content = blankComments(raw);
      for (const pattern of [QUANTITY_TO_FIXED, FOUR_DP_TO_FIXED]) {
        for (const match of content.matchAll(pattern)) {
          found.add(`${path}:${lineOf(content, match.index)}`);
        }
      }
    }

    // Use `useNumberFormat().formatShareQuantity(value)`: eight decimals so a
    // residual position survives, the reader's own decimal mark, and `-0`
    // normalized. `toFixed` writes a `.` in every locale.
    expect([...found]).toEqual([]);
  });

  it('matches both shapes it was written for', () => {
    // The receiver form and the precision form, each of which shipped here.
    QUANTITY_TO_FIXED.lastIndex = 0;
    expect(QUANTITY_TO_FIXED.test('{Math.abs(tx.quantity).toFixed(4)}')).toBe(true);
    QUANTITY_TO_FIXED.lastIndex = 0;
    expect(QUANTITY_TO_FIXED.test('{holding.totalShares.toFixed(8)}')).toBe(true);
    FOUR_DP_TO_FIXED.lastIndex = 0;
    expect(FOUR_DP_TO_FIXED.test('{splitPreview.currentAvg.toFixed(4)}')).toBe(true);

    // And leaves a rate and a money figure to the rules that own them: an FX
    // rate is 6dp by `FX_RATE_DISPLAY_DECIMALS` and a percentage is the `%`
    // scan's subject in `src/test/number-locale.guard.test.ts`.
    QUANTITY_TO_FIXED.lastIndex = 0;
    expect(QUANTITY_TO_FIXED.test('item.rate.toFixed(FX_RATE_DISPLAY_DECIMALS)')).toBe(false);
    FOUR_DP_TO_FIXED.lastIndex = 0;
    expect(FOUR_DP_TO_FIXED.test('point.savingsRate.toFixed(1)')).toBe(false);
  });

  it('offers the formatter to migrate to', () => {
    // Without it the rule has no answer for a holdings column.
    const hook = import.meta.glob('/src/hooks/useNumberFormat.ts', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>;
    expect(hook['/src/hooks/useNumberFormat.ts']).toContain(
      'const formatShareQuantity = useCallback',
    );
  });
});
