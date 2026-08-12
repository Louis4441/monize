/**
 * Is a provider's response actually a daily series?
 *
 * **A chunk coarser than daily is not a sparse daily series, it is a different
 * series.** Ask a provider for a long range and it may answer with weekly or
 * monthly bars; stored into a daily table those rows are indistinguishable from
 * daily ones, and everything downstream reads them as such. They also overwrite
 * whatever real daily rows already sat on those dates, so the damage is not
 * confined to the rows added.
 *
 * `market_index_prices` has refused coarse payloads since it was written.
 * `security_prices` did not, and the result was a six-year stretch of one
 * adjusted row per month spliced through a daily history -- which, under the
 * one-basis-per-series rule in `docs/time-series-contract.md`, silently reduced
 * every return series over that window to twelve points a year, the daily rows
 * around them dropped for carrying no adjusted close.
 *
 * So the test lives here, once, and `bulkUpsertPrices` applies it to every
 * provider payload before writing. `daily-spacing.util.spec.ts` fails if a
 * second copy of it appears.
 */

/**
 * The widest median spacing a response may have and still be a daily series.
 *
 * Daily closes sit one day apart with a three-day step over a weekend, so the
 * median is 1; weekly bars give 7 and monthly about 30. Four separates them
 * with room to spare.
 */
export const MAX_DAILY_GAP_DAYS = 4;

/**
 * Bars needed before spacing is worth judging.
 *
 * A settlement pass over a short window, or a thinly traded instrument, can
 * legitimately return two or three bars, and the median of one or two gaps says
 * more about which days happened to be holidays than about the series. Below
 * this the answer is "cannot tell", and a payload nobody can convict is
 * written -- the guard exists to catch a monthly series arriving in place of
 * years of daily data, which is never three bars long.
 */
export const MIN_BARS_FOR_SPACING_VERDICT = 5;

/**
 * Median whole days between consecutive observations, or null when there are
 * fewer than two. The median rather than the mean: one long exchange closure
 * must not make a daily series look weekly.
 */
export function medianGapDays(dates: readonly Date[]): number | null {
  if (dates.length < 2) return null;
  const ordered = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    gaps.push(
      Math.round(
        (ordered[i].getTime() - ordered[i - 1].getTime()) / 86_400_000,
      ),
    );
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/**
 * True when `dates` are far enough apart that they cannot be a daily series.
 *
 * False for a sample too small to judge -- see `MIN_BARS_FOR_SPACING_VERDICT`.
 */
export function isCoarserThanDaily(dates: readonly Date[]): boolean {
  if (dates.length < MIN_BARS_FOR_SPACING_VERDICT) return false;
  const spacing = medianGapDays(dates);
  return spacing !== null && spacing > MAX_DAILY_GAP_DAYS;
}

/** Raised rather than writing a coarse payload into a daily table. */
export class CoarseSeriesError extends Error {
  constructor(
    readonly subject: string,
    readonly medianGap: number,
    readonly bars: number,
  ) {
    super(
      `${subject}: provider returned ${bars} bars about ${medianGap} day(s) apart; ` +
        `a daily series was requested. Refusing to store a coarser series as daily.`,
    );
    this.name = "CoarseSeriesError";
  }
}

/**
 * Throw unless `dates` are daily. `subject` names the instrument so the log
 * line says which symbol was refused rather than only that something was.
 */
export function assertDailySeries(
  subject: string,
  dates: readonly Date[],
): void {
  if (!isCoarserThanDaily(dates)) return;
  throw new CoarseSeriesError(subject, medianGapDays(dates)!, dates.length);
}
