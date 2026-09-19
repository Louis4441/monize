/**
 * The trailing windows the Investments page reports a portfolio result over,
 * and where each one starts.
 *
 * The dates are the client's own range arithmetic moved to the server, so the
 * batch route answers exactly what six calls to the single-range route would
 * have: `frontend/src/lib/date-range.ts` resolves `1w` as seven days back, `1m`
 * as thirty days, `3m` as ninety, `ytd` as January 1 and `1y` as the same day a
 * year earlier, and `frontend/src/components/investments/portfolio-change-baseline.ts`
 * decides which of them measure from the previous close instead of from their
 * first point. `1d` is the one window with no client counterpart: a day's move
 * IS the prior close against the newest one, so its window is the end day alone.
 *
 * Every function here is pure and takes "today" as a string, because the server
 * decides what today is (`todayYMD`) and a window must not depend on the clock
 * of whoever asked.
 */
import { addDaysYMD } from "../common/date-utils";

export const PORTFOLIO_PERIOD_PRESETS = [
  "1d",
  "1w",
  "1m",
  "3m",
  "ytd",
  "1y",
] as const;

export type PortfolioPeriodPreset = (typeof PORTFOLIO_PERIOD_PRESETS)[number];

/**
 * The presets measured from the previous trading day's close rather than from
 * the first point inside the window.
 *
 * A one-day and a one-week window open mid-session, so a change measured from
 * the first point inside them drops whatever the portfolio did between the
 * previous close and that point. Every quote source reports these against the
 * prior close, so this does too -- the same rule, and the same set, as
 * `usesPriorCloseBaseline` on the client.
 */
const PRIOR_CLOSE_PRESETS: ReadonlySet<string> = new Set(["1d", "1w"]);

export function usesPriorCloseBaseline(preset: PortfolioPeriodPreset): boolean {
  return PRIOR_CLOSE_PRESETS.has(preset);
}

export function isPortfolioPeriodPreset(
  value: string,
): value is PortfolioPeriodPreset {
  return (PORTFOLIO_PERIOD_PRESETS as readonly string[]).includes(value);
}

/**
 * The same calendar day one year earlier, clamped to the month's last day so
 * February 29 steps back to February 28 rather than rolling into March -- the
 * behaviour of `subYears`, which is what the client's `1y` range uses.
 */
function oneYearEarlier(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const lastDayOfMonth = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  const clamped = Math.min(day, lastDayOfMonth);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year - 1}-${pad(month)}-${pad(clamped)}`;
}

/** The first day the preset's window covers, given the day it ends on. */
export function presetWindowStart(
  preset: PortfolioPeriodPreset,
  today: string,
): string {
  switch (preset) {
    case "1d":
      return today;
    case "1w":
      return addDaysYMD(today, -7);
    case "1m":
      return addDaysYMD(today, -30);
    case "3m":
      return addDaysYMD(today, -90);
    case "ytd":
      return `${today.slice(0, 4)}-01-01`;
    case "1y":
      return oneYearEarlier(today);
  }
}

/**
 * The earliest day the preset can need a value for.
 *
 * For a prior-close preset that is the day before its window opens: the actual
 * baseline is the day before the window's FIRST POINT, which cannot be earlier
 * than this. It is what the series and the flows are loaded from, never what
 * the result is measured from.
 */
export function presetEarliestDate(
  preset: PortfolioPeriodPreset,
  today: string,
): string {
  const start = presetWindowStart(preset, today);
  return usesPriorCloseBaseline(preset) ? addDaysYMD(start, -1) : start;
}
