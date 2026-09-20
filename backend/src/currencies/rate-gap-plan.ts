import { addDaysYMD } from "../common/date-utils";
import {
  BOUNDARY_LAG_DAYS,
  daysBetween,
} from "../common/time-series/price-boundary.util";
import { FX_MAX_RATE_AGE_DAYS } from "../common/time-series/fx-rate-resolver";

/**
 * Which provider windows would close the holes in one pair's stored history.
 *
 * A planner rather than a loop, for the reason `net-worth/series-rate-fill.ts`
 * is one: the policy here is the whole feature, and it is worth testing without
 * a provider, a database or a clock.
 *
 * **A missing row is not a hole.** `resolveFxRate` answers a date with the
 * newest observation on or before it, up to `FX_MAX_RATE_AGE_DAYS` old, so
 * every weekend, every holiday and every short provider outage is already
 * answered by the row before it. A date is unresolvable only when *nothing*
 * falls in the 45 days before it, and that is the only thing worth spending a
 * provider call on. A day-by-day "no row here" spine would report every
 * Saturday as a gap and fetch the whole history to fix one.
 *
 * `docs/specs/fx-history-gap-fill.md` is the contract this implements.
 */

/**
 * Windows fetched in one request.
 *
 * Each is one outbound provider call (two, when the direct symbol answers
 * nothing and the reverse is tried), so the cap is what keeps a press of a
 * button bounded. What it leaves out is reported rather than dropped: the plan
 * is recomputed from what is stored, so pressing again continues where this
 * one stopped.
 */
export const MAX_GAP_WINDOWS = 8;

/**
 * Wall-clock budget for one fill, checked between windows.
 *
 * The cap alone does not bound the request: a slow provider turns eight
 * windows into a minute of somebody watching a spinner. Whichever bound is
 * reached first stops the loop, and the remainder is reported the same way.
 */
export const GAP_FILL_BUDGET_MS = 20_000;

/**
 * The widest window one provider request may cover.
 *
 * Asked for decades in one breath Yahoo answers with monthly bars stamped on
 * the 1st, each carrying the month's close under the wrong date;
 * `persistRateSeries` would store those as daily observations. A one-year
 * window always comes back daily. `MarketIndexService` chunks at the same
 * figure, for the same reason, and prices have `assertDailySeries` behind them
 * as well -- exchange rates do not, so this chunking is the whole protection.
 */
export const GAP_WINDOW_MAX_DAYS = 365;

/** One provider request: an inclusive `YYYY-MM-DD` range. */
export interface RateGapWindow {
  readonly start: string;
  readonly end: string;
}

export interface RateGapPlan {
  /** Oldest first, each at most `GAP_WINDOW_MAX_DAYS` long, capped. */
  readonly windows: RateGapWindow[];
  /** Calendar days in the span no stored observation can answer. */
  readonly unresolvableDays: number;
  /** Windows the cap left out. Pressing again plans them. */
  readonly remainingWindows: number;
}

/** Inclusive day count, so a single-day range is 1. */
function inclusiveDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

/**
 * The runs of dates in `[spanStart, spanEnd]` that no observation can answer.
 *
 * Computed from the observations themselves rather than by walking the
 * calendar: a date is unresolvable exactly when it is more than `maxAgeDays`
 * after the newest observation at or before it, which makes each run the
 * stretch between one observation's reach and the next observation.
 *
 * `observations` may include dates before `spanStart` -- an observation a
 * fortnight before the span is what answers its first days -- and anything
 * after `spanEnd` is ignored, because a rate struck after a date never stands
 * for it (INV-FX-001).
 */
function unresolvableRuns(
  observations: readonly string[],
  spanStart: string,
  spanEnd: string,
  maxAgeDays: number,
): RateGapWindow[] {
  const inScope = observations
    .filter((date) => date <= spanEnd)
    .sort((a, b) => a.localeCompare(b));

  if (inScope.length === 0) return [{ start: spanStart, end: spanEnd }];

  const runs: RateGapWindow[] = [];
  const push = (start: string, end: string) => {
    const from = start < spanStart ? spanStart : start;
    const to = end > spanEnd ? spanEnd : end;
    if (from <= to) runs.push({ start: from, end: to });
  };

  // Before the first observation nothing can be carried forward from: a
  // lookup may not reach forwards to the observation that follows it.
  push(spanStart, addDaysYMD(inScope[0], -1));

  for (let i = 0; i < inScope.length; i++) {
    const reach = addDaysYMD(inScope[i], maxAgeDays);
    const next = inScope[i + 1];
    // The day after this observation's reach until the day before the next one
    // answers anything. With no next observation, the run ends with the span.
    push(addDaysYMD(reach, 1), next ? addDaysYMD(next, -1) : spanEnd);
  }

  return runs;
}

/** A window split into pieces the provider still answers daily. */
function chunkWindow(window: RateGapWindow): RateGapWindow[] {
  const chunks: RateGapWindow[] = [];
  let start = window.start;
  while (start <= window.end) {
    const proposed = addDaysYMD(start, GAP_WINDOW_MAX_DAYS - 1);
    const end = proposed > window.end ? window.end : proposed;
    chunks.push({ start, end });
    start = addDaysYMD(end, 1);
  }
  return chunks;
}

/**
 * The provider windows that would make every date in `[spanStart, spanEnd]`
 * answerable, oldest first.
 *
 * `storedDates` are the pair's observations as `YYYY-MM-DD`, in either stored
 * orientation, deduplicated by date; order does not matter. Pass the ones from
 * `maxAgeDays` before `spanStart` onwards, or the span's first days are
 * reported as a hole an earlier observation already fills.
 *
 * Oldest first because a report fails from its start date: covering the oldest
 * hole is what makes an all-time chart start answering, and a partially
 * completed fill then leaves a contiguous span rather than a scatter.
 */
export function planRateGapWindows(
  storedDates: readonly string[],
  spanStart: string,
  spanEnd: string,
  maxAgeDays: number = FX_MAX_RATE_AGE_DAYS,
  maxWindows: number = MAX_GAP_WINDOWS,
): RateGapPlan {
  if (spanStart > spanEnd) {
    return { windows: [], unresolvableDays: 0, remainingWindows: 0 };
  }

  const runs = unresolvableRuns(storedDates, spanStart, spanEnd, maxAgeDays);
  const unresolvableDays = runs.reduce(
    (sum, run) => sum + inclusiveDays(run.start, run.end),
    0,
  );

  const planned = runs.flatMap((run) =>
    // Lead so the run's first day has an observation to carry forward from
    // even where the provider's first bar of the window lands late. The end is
    // never extended: a window running past `spanEnd` would ask for dates the
    // market has not reached.
    chunkWindow({
      start: addDaysYMD(run.start, -BOUNDARY_LAG_DAYS),
      end: run.end,
    }),
  );

  const kept = maxWindows > 0 ? planned.slice(0, maxWindows) : [];
  return {
    windows: kept,
    unresolvableDays,
    remainingWindows: planned.length - kept.length,
  };
}
