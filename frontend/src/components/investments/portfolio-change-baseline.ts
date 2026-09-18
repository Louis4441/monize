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
 * Whether this chart measures its change from the prior trading day's close.
 *
 * A property of the range and nothing else. This was briefly also a user
 * preference (`portfolio_change_baseline`, migrations 152 and 153); it was
 * removed because the answer every quote source gives for a daily move is the
 * prior close, and offering the other one asked the user to adjudicate
 * something with a right answer.
 */
export function usesPriorCloseBaseline(range: string): boolean {
  return PRIOR_CLOSE_BASELINE_RANGES.has(range);
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
