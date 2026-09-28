import { format, subDays, subMonths, subYears } from 'date-fns';
import { resolveRangePreset, type ResolveRangeOptions } from '@/lib/date-range';

/**
 * Where a Portfolio Value chart's window opens, per range.
 *
 * Separate from `resolveRangePreset` on purpose. That function answers "what
 * period is the user asking about", and ten other reports depend on its
 * answer -- a spending report's 3M window must not quietly start a day early.
 * This one answers a narrower question that only a *price* chart has: **which
 * close is the series measured from**, so the figure beside it matches what
 * every other quote source reports for the same period.
 *
 * The rules are not uniform, and that is deliberate rather than an oversight:
 * they were each set to match what the platforms being compared against
 * actually show.
 *
 * | Range | Opens on | Why |
 * |---|---|---|
 * | 1D, 1W, MTD | unchanged | already measured from the prior close, via `PRIOR_CLOSE_BASELINE_RANGES` |
 * | 1M | unchanged | intraday; the first *day* is collapsed to its close by `trimIntradayToFirstDayClose` |
 * | 3M, 6M | the day before the period starts | so the first plotted close precedes the period |
 * | YTD | 31 December of the previous year | the year is measured from its last session's close, which that day carries |
 * | 1Y, 2Y, 5Y | the day before the anniversary | today - 1 year - 1 day, and so on |
 *
 * A rule naming an exact day overrides month alignment, which is why these do
 * not consult `options.alignment`: "the day before the anniversary" has no
 * month-aligned reading.
 */
export type PortfolioWindowStart =
  /** Take `resolveRangePreset`'s answer unchanged. */
  | { kind: 'inherit' }
  /** The calendar day before `years`/`months` ago. */
  | { kind: 'dayBefore'; years?: number; months?: number }
  /**
   * 31 December of the previous year. A day is valued from the latest close
   * on or before it, so a year-end on a weekend or holiday still carries the
   * last session's close, and the period result's `startPriceDate` names it.
   */
  | { kind: 'previousYearEnd' };

export const PORTFOLIO_WINDOW_STARTS: Readonly<
  Record<string, PortfolioWindowStart>
> = {
  '1d': { kind: 'inherit' },
  '1w': { kind: 'inherit' },
  mtd: { kind: 'inherit' },
  '1m': { kind: 'inherit' },
  '3m': { kind: 'dayBefore', months: 3 },
  '6m': { kind: 'dayBefore', months: 6 },
  ytd: { kind: 'previousYearEnd' },
  '1y': { kind: 'dayBefore', years: 1 },
  '2y': { kind: 'dayBefore', years: 2 },
  '5y': { kind: 'dayBefore', years: 5 },
};

/**
 * The window a Portfolio Value chart should request for `range`.
 *
 * Falls through to `resolveRangePreset` for every range with no rule of its
 * own, so an unrecognised range behaves exactly as it does everywhere else.
 */
export function resolvePortfolioRangeWindow(
  range: string,
  options: ResolveRangeOptions = {},
): { start: string; end: string } {
  return applyPortfolioWindowStart(
    range,
    resolveRangePreset(range, options),
    options,
  );
}

/**
 * Apply the portfolio rule on top of a window somebody else already resolved.
 *
 * The report and the Investments chart get their base window from
 * `useDateRange`, which also carries the user's custom start/end dates; taking
 * its answer rather than re-deriving one is what keeps a custom range custom.
 */
export function applyPortfolioWindowStart(
  range: string,
  base: { start: string; end: string },
  options: ResolveRangeOptions = {},
): { start: string; end: string } {
  const rule = PORTFOLIO_WINDOW_STARTS[range];
  if (!rule || rule.kind === 'inherit') return base;

  const now = options.now ?? new Date();
  if (rule.kind === 'previousYearEnd') {
    return { ...base, start: `${now.getFullYear() - 1}-12-31` };
  }

  const anniversary =
    rule.years !== undefined
      ? subYears(now, rule.years)
      : subMonths(now, rule.months ?? 0);
  return { ...base, start: format(subDays(anniversary, 1), 'yyyy-MM-dd') };
}
