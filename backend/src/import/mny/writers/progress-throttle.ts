import { MnyImportProgress } from "../model/mny-import-job";

/**
 * Rate-limits a job's progress reports to something a poller can actually see.
 *
 * Every writer reports after each chunk of 500 rows, which on the maintainer's
 * Money Plus file is 74 reports for transactions and 136 for prices. Each one is
 * not a cheap update: `reportProgress` deliberately escapes the import's
 * transaction (`runOutsideActiveScopedManager`), so it takes a **second pool
 * connection** and opens its own transaction while the long one is still open.
 * The wizard polls every 1500 ms, so all but a handful of those writes are
 * overwritten before anyone reads them.
 *
 * Throttling by wall clock rather than by row count keeps the bar moving at the
 * same visible rate whatever the file size, and turns a few hundred extra
 * transactions per import into a few dozen.
 *
 * The final report of a phase always goes through. A phase that ends between
 * ticks would otherwise leave the bar short of the total it just reached, and a
 * short phase would report nothing at all.
 */

/**
 * Comfortably under the wizard's 1500 ms poll, so a poll rarely finds the same
 * numbers twice, and far above the chunk rate, so most writes disappear.
 */
export const PROGRESS_MIN_INTERVAL_MS = 1000;

export type ProgressReporter = (progress: MnyImportProgress) => Promise<void>;

/**
 * Wraps `report` so it fires at most once per `intervalMs`, plus whenever a
 * phase reaches its total.
 *
 * `now` is injectable because the behaviour under test is entirely about the
 * passage of time.
 */
export function throttleProgress(
  report: ProgressReporter,
  intervalMs: number = PROGRESS_MIN_INTERVAL_MS,
  now: () => number = Date.now,
): ProgressReporter {
  let lastReportedAt = Number.NEGATIVE_INFINITY;

  return async (progress) => {
    const isPhaseEnd =
      progress.total > 0 && progress.processed >= progress.total;
    const timestamp = now();

    if (!isPhaseEnd && timestamp - lastReportedAt < intervalMs) {
      return;
    }

    lastReportedAt = timestamp;
    await report(progress);
  };
}
