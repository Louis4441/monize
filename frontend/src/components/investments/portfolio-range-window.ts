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
 * | YTD | the year's first **trading** day | not 1 January, which carries December's close |
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
  /** The first day of the year on which anything held was actually priced. */
  | { kind: 'firstPricedDayOfYear' };

export const PORTFOLIO_WINDOW_STARTS: Readonly<
  Record<string, PortfolioWindowStart>
> = {
  '1d': { kind: 'inherit' },
  '1w': { kind: 'inherit' },
  mtd: { kind: 'inherit' },
  '1m': { kind: 'inherit' },
  '3m': { kind: 'dayBefore', months: 3 },
  '6m': { kind: 'dayBefore', months: 6 },
  ytd: { kind: 'firstPricedDayOfYear' },
  '1y': { kind: 'dayBefore', years: 1 },
  '2y': { kind: 'dayBefore', years: 2 },
  '5y': { kind: 'dayBefore', years: 5 },
};

export interface PortfolioWindowOptions extends ResolveRangeOptions {
  /**
   * The year's first priced day, from `netWorthApi.getFirstPricedDay`. Null or
   * absent -- not loaded yet, or the scope holds nothing priced -- keeps the
   * calendar boundary rather than inventing a trading day.
   */
  ytdFirstPricedDay?: string | null;
}

/**
 * The window a Portfolio Value chart should request for `range`.
 *
 * Falls through to `resolveRangePreset` for every range with no rule of its
 * own, so an unrecognised range behaves exactly as it does everywhere else.
 */
export function resolvePortfolioRangeWindow(
  range: string,
  options: PortfolioWindowOptions = {},
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
  options: PortfolioWindowOptions = {},
): { start: string; end: string } {
  const rule = PORTFOLIO_WINDOW_STARTS[range];
  if (!rule || rule.kind === 'inherit') return base;

  if (rule.kind === 'firstPricedDayOfYear') {
    return { ...base, start: options.ytdFirstPricedDay || base.start };
  }

  const now = options.now ?? new Date();
  const anniversary =
    rule.years !== undefined
      ? subYears(now, rule.years)
      : subMonths(now, rule.months ?? 0);
  return { ...base, start: format(subDays(anniversary, 1), 'yyyy-MM-dd') };
}

/**
 * Does this range need the year's first priced day looked up before its window
 * can be resolved? Only YTD does, so only YTD pays for the extra request.
 */
export function needsFirstPricedDay(range: string): boolean {
  return PORTFOLIO_WINDOW_STARTS[range]?.kind === 'firstPricedDayOfYear';
}

/** 1 January of the year `now` falls in, as YYYY-MM-DD. */
export function startOfYearIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-01-01`;
}
