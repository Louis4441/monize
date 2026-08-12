import { netWorthApi } from '@/lib/net-worth';
import { createLogger } from '@/lib/logger';
import type { PortfolioChangeBaseline } from '@/types/investment';

const logger = createLogger('PortfolioChangeBaseline');

/**
 * What the change is measured from when the user has expressed no preference:
 * a stored value the client has not loaded yet, or an account predating the
 * column. Matches the column default in `database/schema.sql`, so the first
 * render and the server agree.
 */
export const DEFAULT_PORTFOLIO_CHANGE_BASELINE: PortfolioChangeBaseline =
  'previous_close';

/**
 * Ranges whose "Change" is measured from the close of the last trading day
 * *before* the window, rather than from the first point plotted.
 *
 * A 1D chart starts at today's open, a 1W chart at the first bar of the week
 * shown and an MTD chart at the first bar of the month -- so a change measured
 * from the first plotted point silently drops whatever the portfolio did
 * between the previous close and that point. Every other quote source reports
 * these three against the prior close, so this does too.
 *
 * The longer ranges (1M, 3M, YTD, 1Y, ...) keep measuring from their first
 * point: there the window boundary is an arbitrary calendar date rather than a
 * session boundary, and the first point already *is* the close of the day the
 * window opens on.
 */
export const PRIOR_CLOSE_BASELINE_RANGES = new Set(['1d', '1w', 'mtd']);

/**
 * How far back the baseline lookup reaches. The daily-value endpoint prices a
 * day from the latest close at or before it, but only loads prices from a week
 * before the window it is asked for -- so asking for the single baseline day
 * alone would value a thinly-traded holding at nothing over a long market
 * closure. Asking for a month of context costs one cheap query and removes the
 * cliff.
 */
export const BASELINE_LOOKBACK_DAYS = 30;

/**
 * Whether this chart measures its change from the prior trading day's close.
 *
 * Both halves have to hold: the range must be one where the two baselines
 * differ at all, and the user must not have chosen `period_start`. An absent
 * preference (still loading, or an account predating the column) takes the
 * default rather than the other option, so the answer never flips as the
 * preferences arrive.
 */
export function usesPriorCloseBaseline(
  range: string,
  preference?: PortfolioChangeBaseline | null,
): boolean {
  const setting = preference ?? DEFAULT_PORTFOLIO_CHANGE_BASELINE;
  return setting === 'previous_close' && PRIOR_CLOSE_BASELINE_RANGES.has(range);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shift a YYYY-MM-DD date by `days`, in UTC so it cannot drift a day. */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** The calendar day before a YYYY-MM-DD date. */
export function previousCalendarDay(iso: string): string {
  return shiftIsoDate(iso, -1);
}

/**
 * The date part of a chart point. Daily points already carry a YYYY-MM-DD
 * date; intraday points carry a full ISO timestamp, whose date half is taken
 * as-is (UTC), matching how the MTD range filters its own intraday points.
 * Returns null for anything that is not a date, so a caller treats the
 * baseline as unknown rather than guessing at one.
 */
export function isoDatePart(value: string | undefined): string | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  return ISO_DATE.test(date) ? date : null;
}

/** The close a prior-close change is measured from. */
export interface PriorCloseBaseline {
  /**
   * The request this baseline answers. A baseline is only usable while it
   * still matches the chart on screen -- see `buildPriorCloseKey`.
   */
  key: string;
  /** Date (YYYY-MM-DD) whose close the change is measured from. */
  date: string;
  /** Portfolio value at that close, in the chart's display currency. */
  value: number;
}

/**
 * Identity of a baseline request: everything that changes which close the
 * change is measured from, or what that close is worth. A baseline whose key
 * no longer matches the chart describes a different chart and reads as
 * unknown.
 */
export function buildPriorCloseKey(parts: {
  range: string;
  firstPointDate: string;
  accountIds?: string;
  displayCurrency?: string;
}): string {
  return [
    parts.range,
    parts.firstPointDate,
    parts.accountIds ?? '',
    parts.displayCurrency ?? '',
  ].join('|');
}

/**
 * Pick the prior close out of a daily-value series: the latest day strictly
 * before the chart's first point. The series values every calendar day at the
 * latest close at or before it, so the day before a Monday session already
 * carries the preceding Friday's close and no trading calendar is needed.
 *
 * Returns null when the series does not reach back that far -- unknown, never
 * zero.
 */
export function selectPriorClose(
  rows: ReadonlyArray<{ date: string; value: number }>,
  firstPointDate: string,
): { date: string; value: number } | null {
  let picked: { date: string; value: number } | null = null;
  for (const row of rows) {
    if (row.date >= firstPointDate) continue;
    if (!picked || row.date > picked.date) picked = { date: row.date, value: row.value };
  }
  return picked;
}

/**
 * Load the portfolio's value at the close before `firstPointDate`.
 *
 * Returns null when the value cannot be established (the request failed, or
 * the series has nothing before that day). Null is "not known" and must not be
 * rendered as a change of zero.
 *
 * Two properties inherited from the daily-value endpoint, neither of them
 * hidden: it rounds each day to whole currency units, so the change is exact
 * to within half a unit; and it values a day from the latest close at or
 * before it, so a portfolio whose prices have not updated since before the
 * window resolves both ends to the same close and reports a change of exactly
 * zero -- which is the same answer a genuinely flat market gives (see
 * `docs/time-series-contract.md` section 2.3). Telling those apart needs the
 * per-security quote dates, which this layer does not have.
 */
export async function fetchPriorCloseBaseline(params: {
  key: string;
  firstPointDate: string;
  accountIds?: string;
  displayCurrency?: string;
}): Promise<PriorCloseBaseline | null> {
  const { key, firstPointDate, accountIds, displayCurrency } = params;
  const endDate = previousCalendarDay(firstPointDate);
  const startDate = shiftIsoDate(endDate, -BASELINE_LOOKBACK_DAYS);
  try {
    const rows = await netWorthApi.getInvestmentsDaily({
      startDate,
      endDate,
      accountIds,
      displayCurrency,
    });
    const picked = selectPriorClose(rows, firstPointDate);
    return picked ? { key, ...picked } : null;
  } catch (error) {
    logger.error('Failed to load prior-close baseline:', error);
    return null;
  }
}

/**
 * Change from a baseline, and that change as a percentage of it.
 *
 * Both are null when the baseline is unknown. The percentage is also null when
 * the baseline is zero: a move away from nothing has no percentage, and 0%
 * would report the opposite of what happened.
 */
export function priorCloseChange(
  current: number,
  baseline: number | null,
): { change: number | null; changePercent: number | null } {
  if (baseline === null) return { change: null, changePercent: null };
  // Integer arithmetic at the storage precision, so a subtraction of two
  // large values cannot leave float dust behind.
  const change =
    (Math.round(current * 10000) - Math.round(baseline * 10000)) / 10000;
  return {
    change,
    changePercent: baseline === 0 ? null : (change / Math.abs(baseline)) * 100,
  };
}
