import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import { tr } from "../../i18n/translate";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../common/db/scoped-db";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import { ImportJob, ONE_ACTIVE_JOB_INDEX } from "./entities/import-job.entity";
import { MnyImportError } from "./mny-errors";
import { MnyImportProgress, MnyImportResult } from "./model/mny-import-job";
import { MnyImportOptions } from "./model/mny-import-options";

/**
 * Lifecycle of a background `.mny` import (design ADR-3).
 *
 * No queue, no Redis, no second process: `POST /import/mny/start` inserts a
 * `pending` row, exactly one worker claims it with a conditional UPDATE, and the
 * body runs as an unawaited in-process task under `withUserContext`. The wizard
 * polls the row.
 *
 * Three things make that safe on Kubernetes, where every replica runs the same
 * code: the insert is guarded by a partial unique index, so two *requests*
 * racing to start an import produce one job; the claim is atomic, so two pods
 * racing over that one job produce one winner; and a running job heartbeats, so
 * a job whose pod died is reaped into `failed` + retryable instead of appearing
 * to run forever.
 *
 * Reaping is demand-driven. A stale row is not a tidiness problem -- the partial
 * unique index makes it refuse every future import that user starts, and
 * `discard` cannot touch it once it reached `running` -- so the two requests that
 * care clear it in their own transaction before deciding: `create`, which is
 * about to be refused by it, and `findOne`, which the wizard polls and which
 * would otherwise keep rendering a progress bar for a worker that is gone.
 * `reapStaleJobs` remains as an hourly cross-user backstop for the user who
 * closed the tab and never asked again.
 */

/** A job with no heartbeat for this long is presumed dead. */
export const JOB_STALE_AFTER_MS = 5 * 60 * 1000;

/** How often a running job proves it is alive. */
export const JOB_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** i18n key for a job the reaper gave up on. */
export const JOB_STALLED_ERROR_KEY = "mnyJobStalled";

/** i18n key for a failure with no more specific parse error. */
export const JOB_FAILED_ERROR_KEY = "mnyImportFailed";

/**
 * Thrown when a job discovers, inside its own write transaction, that it no
 * longer holds its user's import slot. Not a parse failure: retrying is exactly
 * the right thing to offer, since the staged bytes are untouched.
 */
export class MnyImportSlotLostError extends Error {
  constructor(jobId: string, status: string) {
    super(
      `Import job ${jobId} no longer holds the import slot (status ${status})`,
    );
    this.name = "MnyImportSlotLostError";
  }
}

/** PostgreSQL SQLSTATE for a unique violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The condition deciding that a job's worker is gone, in terms of `$1` -- the
 * staleness threshold in milliseconds.
 *
 * Written once because three callers ask the same question and have to agree:
 * the per-user reap inside `create`, the same reap inside the poller's
 * `findOne`, and `hasActiveJob`, which must consider *inactive* exactly what
 * those two would clear. A fourth copy of these clauses, drifted by one, is a
 * user told an import is already running by a row the very next statement would
 * have reaped -- and no test would see it, because each site would still be
 * self-consistent.
 *
 * A `running` row with no heartbeat at all counts as stale. `claim` stamps one
 * in the same UPDATE that sets the status, so it should be unreachable; without
 * the null arm it is the one state nothing can ever clear, because `NULL <
 * timestamp` is NULL and the row matches neither the reap nor its negation.
 */
export const STALE_ACTIVE_JOB_CONDITION = `(
              status = 'running'
          AND (
                heartbeat_at IS NULL
             OR heartbeat_at < CURRENT_TIMESTAMP - ($1::text || ' milliseconds')::interval
              )
            )
            OR (
              status = 'pending'
          AND created_at < CURRENT_TIMESTAMP - ($1::text || ' milliseconds')::interval
            )`;

/**
 * The reap, in terms of `$1` (staleness threshold, ms) and `$2` (the i18n key);
 * `scopedToUser` restricts it to `$3` and is how the per-request reap stays
 * inside the caller's own rows.
 *
 * The `AND` binds tighter than the condition's `OR`, so the parenthesis around
 * it is the whole difference between "this user's stale jobs" and "this user's
 * jobs, plus everybody's stale pending ones". `reapStatement` is exported so a
 * test can assert that grouping rather than trusting the reader to see it.
 */
export const reapStatement = (scopedToUser: boolean): string => `
    UPDATE import_jobs
        SET status = 'failed',
            error_key = $2,
            error_detail = CASE
              WHEN status = 'running'
                THEN 'Import worker stopped reporting progress'
              ELSE 'Import was never picked up by a worker'
            END,
            retryable = true,
            progress = NULL,
            completed_at = CURRENT_TIMESTAMP
      WHERE ${scopedToUser ? "user_id = $3 AND " : ""}(
            ${STALE_ACTIVE_JOB_CONDITION}
          )
      RETURNING id`;

/**
 * True when this error is the one-active-import-per-user index refusing an
 * INSERT, rather than any other unique constraint on the table.
 *
 * Matching on the constraint name and not merely on the SQLSTATE matters: a
 * different violation means something the caller has no business reporting as
 * "an import is already running".
 */
export function isActiveJobConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driver = error.driverError as
    | { code?: string; constraint?: string }
    | undefined;
  return (
    driver?.code === UNIQUE_VIOLATION &&
    driver?.constraint === ONE_ACTIVE_JOB_INDEX
  );
}

/** The 409 the wizard already renders when a second import is refused. */
export function importAlreadyRunningException(): ConflictException {
  return new ConflictException(
    tr(
      "errors.import.mnyImportAlreadyRunning",
      "An import is already running. Wait for it to finish before starting another.",
    ),
  );
}

/** What a job body can report while it runs. */
export interface JobRunContext {
  readonly jobId: string;
  readonly userId: string;
  /** Publishes progress the poller can see immediately. */
  reportProgress(progress: MnyImportProgress): Promise<void>;
}

export type JobBody = (context: JobRunContext) => Promise<MnyImportResult>;

/**
 * The rows a `query()` returned, whichever shape TypeORM chose.
 *
 * A data-modifying statement with `RETURNING` comes back as `[rows, rowCount]`,
 * while a `SELECT` comes back as bare rows. Reading that wrong fails silently in
 * the worst possible direction: `result.length > 0` on the tuple is always true,
 * so every conditional claim would look like a winner and two workers would
 * import the same file. Found by the concurrency spec, kept honest by it.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[]);
}

@Injectable()
export class MnyImportJobService {
  private readonly logger = new Logger(MnyImportJobService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Creates a `pending` job, or throws 409 when this user already has one in
   * flight. Returns the row the wizard will poll.
   *
   * The refusal is the INSERT itself, not a preceding count: `hasActiveJob`
   * followed by `create` is two transactions, and two concurrent starts can
   * both read zero before either writes -- which imported the same staged file
   * twice, with fresh transaction UUIDs each time so nothing deduplicated the
   * second run. The partial unique index makes the loser block on the winner
   * and then fail, so the check and the write are one atomic act.
   *
   * The stale reap runs first, in that same transaction, because only a row
   * whose worker is still alive has any business refusing this request. Reaped
   * in a separate transaction it would settle nothing: the answer could change
   * between the two, which is the same defect as counting before inserting.
   */
  async create(
    userId: string,
    stagedFileId: string,
    options: MnyImportOptions,
  ): Promise<ImportJob> {
    try {
      return await withScopedDb(this.dataSource, async (manager) => {
        await this.reapStaleJobsForUser(manager, userId);
        const repo = manager.getRepository(ImportJob);
        return repo.save(
          repo.create({
            userId,
            stagedFileId,
            sourceFormat: "mny",
            status: "pending",
            options,
            retryable: false,
          }),
        );
      });
    } catch (error) {
      if (isActiveJobConflict(error)) {
        throw importAlreadyRunningException();
      }
      throw error;
    }
  }

  /**
   * Deletes a job that never started, releasing this user's import slot.
   *
   * `start` creates the row *before* the optional destructive wipe, so the wipe
   * runs under the same lock the import does -- but a wipe that fails
   * re-authentication must not leave the user holding a slot for a job that
   * will never run. Restricted to `pending`: a claimed job belongs to its
   * worker, which reports its own outcome.
   */
  async discard(userId: string, jobId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `DELETE FROM import_jobs
          WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
        [jobId, userId],
      ),
    );
  }

  /**
   * The job, or null when it never existed or belongs to another user.
   *
   * This is what the wizard polls, every 1.5s, which makes it the first place a
   * dead worker can be noticed. Reaping this user's stale jobs first -- in the
   * transaction that then reads the row, so the caller cannot see the pre-reap
   * state -- is what turns a progress bar frozen at 40% into the retryable
   * failure it has actually been since the pod died. Without it the wizard
   * renders `running` forever, because nothing in the request path ever
   * contradicts the row.
   */
  async findOne(userId: string, jobId: string): Promise<ImportJob | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      await this.reapStaleJobsForUser(manager, userId);
      return manager
        .getRepository(ImportJob)
        .findOne({ where: { id: jobId, userId } });
    });
  }

  /**
   * True when this user has an import in flight *and still alive*.
   *
   * Advisory only: it answers the question a moment before the answer can
   * change, so it buys a friendly 409 without an INSERT attempt and nothing
   * more. The guarantee lives in `create`'s unique index.
   *
   * The staleness exclusion is not an optimization, it is what makes the
   * advisory answer agree with the authoritative one. This runs *before*
   * `create`, so counting a stale row as active would throw the 409 from here
   * and the request would never reach the transaction that was about to reap
   * it -- restoring, through the pre-check, exactly the lockout the reap
   * exists to end. Hence the shared `STALE_ACTIVE_JOB_CONDITION`: negated here,
   * asserted there, one definition.
   */
  async hasActiveJob(userId: string): Promise<boolean> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT id FROM import_jobs
          WHERE user_id = $2
            AND status IN ('pending', 'running')
            AND NOT (${STALE_ACTIVE_JOB_CONDITION})
          LIMIT 1`,
        [String(JOB_STALE_AFTER_MS), userId],
      ),
    );
    return returnedRows<{ id: string }>(rows).length > 0;
  }

  /**
   * Fails this user's stale jobs **inside the caller's transaction**, and
   * returns what it cleared.
   *
   * This is the reap that matters to a person waiting. A stale row locks its
   * user out of importing entirely: the partial unique index refuses the next
   * start, `discard` is restricted to `pending` so a dead `running` job is
   * beyond the client's reach, and no other request path clears it. Running the
   * reap in the transaction that is about to need the answer means the lockout
   * ends the moment the user next asks, instead of whenever the cron happens to
   * fire.
   *
   * Scoped to one user deliberately. It runs under the caller's own identity,
   * so it can only reach rows they own -- no bypass, and no way for one user's
   * request to retire another's live import. The cross-user sweep stays on the
   * cron, under a system context.
   *
   * @param manager the EntityManager of the ACTIVE transaction whose decision
   *   this clears the way for. Reaped in a separate transaction it guarantees
   *   nothing, because the row can be re-read as active before the caller acts.
   */
  async reapStaleJobsForUser(
    manager: EntityManager,
    userId: string,
  ): Promise<string[]> {
    const result = await manager.query(reapStatement(true), [
      String(JOB_STALE_AFTER_MS),
      JOB_STALLED_ERROR_KEY,
      userId,
    ]);
    const reaped = returnedRows<{ id: string }>(result).map((row) => row.id);
    if (reaped.length > 0) {
      this.logger.warn(
        `Reaped ${reaped.length} stalled import job(s) for user ${userId}: ${reaped.join(", ")}`,
      );
    }
    return reaped;
  }

  /**
   * Verifies this job still holds its user's import slot, **inside the caller's
   * transaction**, and locks the row so the answer cannot change before commit.
   *
   * `claim` protects the start of a job; this protects the end of one. A job can
   * lose its slot after claiming it, and in both cases the row is rewritten by
   * something that cannot stop the worker:
   *
   *  - the one-active-job migration retires older duplicates on a database that
   *    raced before the index existed. Every backend container runs migrations at
   *    start-up and the Helm StatefulSet rolls pods one at a time, so a new pod
   *    can retire a job an *old* pod is still importing;
   *  - `reapStaleJobs` fails a `running` job whose heartbeat lapsed -- a real
   *    possibility for a slow import on a loaded pod, not only for a dead one.
   *
   * Neither changes what the worker does. Status alone therefore cannot protect
   * the data: by the time a terminal write happens the financial rows are already
   * committed. Calling this as the last statement of the transaction that writes
   * them makes the refusal roll them back instead, which is the repository's
   * standing rule -- a rejected command must not already have written.
   *
   * `FOR UPDATE` matters as much as the predicate: it serializes this check
   * against a concurrent retirement, so the loser of that race sees the committed
   * outcome rather than a snapshot taken before it.
   *
   * @param manager the EntityManager of the ACTIVE transaction whose writes this
   *   is guarding -- checked in a separate transaction it guarantees nothing.
   */
  async assertStillHoldsSlot(
    manager: EntityManager,
    jobId: string,
  ): Promise<void> {
    const rows: Array<{ status: string }> = await manager.query(
      `SELECT status FROM import_jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    const status = rows[0]?.status ?? "missing";
    if (status !== "running") {
      throw new MnyImportSlotLostError(jobId, status);
    }
  }

  /**
   * Moves a job from `pending` to `running`, atomically.
   *
   * The `WHERE status = 'pending'` is the whole concurrency control: whichever
   * statement commits first updates one row, the other updates none.
   */
  async claim(jobId: string): Promise<boolean> {
    const result = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE import_jobs
            SET status = 'running',
                started_at = CURRENT_TIMESTAMP,
                heartbeat_at = CURRENT_TIMESTAMP,
                error_key = NULL,
                error_detail = NULL,
                retryable = false
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [jobId],
      ),
    );
    return returnedRows<{ id: string }>(result).length > 0;
  }

  /**
   * Publishes progress in its own transaction, so a wizard polling mid-import
   * sees it. A write inside the import's transaction would stay invisible until
   * commit -- a frozen progress bar for the whole run.
   */
  async reportProgress(
    jobId: string,
    progress: MnyImportProgress,
  ): Promise<void> {
    await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE import_jobs
              SET progress = $2::jsonb, heartbeat_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'running'`,
          [jobId, JSON.stringify(progress)],
        ),
      ),
    );
  }

  /** Proof of life for the reaper, on the same escape hatch as progress. */
  async heartbeat(jobId: string): Promise<void> {
    await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE import_jobs
              SET heartbeat_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'running'`,
          [jobId],
        ),
      ),
    );
  }

  async complete(jobId: string, result: MnyImportResult): Promise<void> {
    await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          // `AND status = 'running'`: a job retired while its body ran must not
          // be flipped back to completed. `assertStillHoldsSlot` normally makes
          // this unreachable by rolling the body back first; this is the second
          // line of defence, and it keeps the audit trail honest either way.
          `UPDATE import_jobs
              SET status = 'completed',
                  result = $2::jsonb,
                  progress = NULL,
                  completed_at = CURRENT_TIMESTAMP,
                  retryable = false
            WHERE id = $1 AND status = 'running'`,
          [jobId, JSON.stringify(result)],
        ),
      ),
    );
  }

  async fail(
    jobId: string,
    errorKey: string,
    errorDetail: string,
    retryable: boolean,
  ): Promise<void> {
    await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE import_jobs
              SET status = 'failed',
                  error_key = $2,
                  error_detail = $3,
                  retryable = $4,
                  progress = NULL,
                  completed_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [jobId, errorKey, errorDetail, retryable],
        ),
      ),
    );
  }

  /**
   * Claims the job and runs `body`, keeping the row's status honest whatever
   * happens. Returns false when another worker already had it.
   *
   * A parse failure (bad file, wrong Money version) is not retryable -- retrying
   * the same bytes cannot help. Anything else is: the staged file survives, so
   * Retry is a new job over the same file.
   */
  async runClaimed(
    userId: string,
    jobId: string,
    body: JobBody,
  ): Promise<boolean> {
    if (!(await this.claim(jobId))) {
      return false;
    }

    // unref: a pending heartbeat must never keep the process alive at shutdown.
    const beat = setInterval(() => {
      void withUserContext(userId, () => this.heartbeat(jobId)).catch(
        () => undefined,
      );
    }, JOB_HEARTBEAT_INTERVAL_MS);
    beat.unref();

    try {
      const result = await body({
        jobId,
        userId,
        reportProgress: (progress) => this.reportProgress(jobId, progress),
      });
      await this.complete(jobId, result);
      this.logger.log(`Import job ${jobId} completed`);
    } catch (error) {
      const isParseFailure = error instanceof MnyImportError;
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof MnyImportSlotLostError) {
        // The row already says why, written by whatever retired it. Overwriting
        // it here would replace that explanation with a generic failure.
        this.logger.warn(detail);
        return true;
      }
      await this.fail(
        jobId,
        isParseFailure ? error.code : JOB_FAILED_ERROR_KEY,
        detail,
        !isParseFailure,
      );
      this.logger.error(`Import job ${jobId} failed: ${detail}`);
    } finally {
      clearInterval(beat);
    }

    return true;
  }

  /**
   * The cross-user backstop for jobs whose worker stopped heartbeating -- a
   * killed pod, an OOM, a rolling restart mid-import -- and for `pending` rows
   * no worker ever claimed, reaped on the same rule measured from creation.
   *
   * Hourly, because it is no longer what any waiting user depends on.
   * `reapStaleJobsForUser` runs on the two requests that care, so the person
   * whose import died sees it fail on their next poll -- about 1.5 seconds after
   * the job goes stale -- and can start another immediately. Firing this every
   * five minutes bought a worst case of ten minutes for a lockout that the
   * request path now ends by itself; what is left for a schedule is the user who
   * closed the tab and never asked again, whose row would otherwise sit
   * `running` in the table indefinitely and misreport the import history.
   *
   * Marked retryable: the staged file is untouched, so the wizard can offer Retry
   * rather than making the user upload 200 MB again. Idempotent across replicas,
   * because the predicate only matches rows still in the state being reaped.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async reapStaleJobs(): Promise<void> {
    try {
      const reaped = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) => {
          const result = await manager.query(reapStatement(false), [
            String(JOB_STALE_AFTER_MS),
            JOB_STALLED_ERROR_KEY,
          ]);
          return returnedRows<{ id: string }>(result).map((row) => row.id);
        }),
      );

      if (reaped.length > 0) {
        this.logger.warn(
          `Reaped ${reaped.length} stalled import job(s): ${reaped.join(", ")}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Import job reaper failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
