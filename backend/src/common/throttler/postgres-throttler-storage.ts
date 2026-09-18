import { Injectable, Logger } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import { DataSource } from "typeorm";

import { returnedRows } from "../db/query-result";
import { runOutsideActiveScopedManager, withScopedDb } from "../db/scoped-db";
import { withSystemContext } from "../db/with-context";

/**
 * What `increment` owes its caller, spelled out here rather than imported.
 *
 * `@nestjs/throttler` does not re-export `ThrottlerStorageRecord` from its
 * barrel, and reaching into `@nestjs/throttler/dist/...` is the deep-path shape
 * that type-checks under `tsc` and then fails to resolve under `ts-jest` --
 * `ScopedDbIsolation` in `common/db/scoped-db.ts` is spelled out for exactly
 * that reason. TypeScript is structural, so `implements ThrottlerStorage` still
 * checks this against the library's own signature: a field renamed upstream
 * fails the build here rather than silently returning the wrong shape.
 */
export interface ThrottleRecord {
  totalHits: number;
  /** Whole seconds until the counting window ends. */
  timeToExpire: number;
  isBlocked: boolean;
  /** Whole seconds until a block lifts; `0` when nothing is blocked. */
  timeToBlockExpire: number;
}

/**
 * The HTTP throttler's counters, on a row instead of in this process's memory.
 *
 * `ThrottlerModule.forRoot` with no `storage` keeps a `Map` in the guard, so
 * every `@Throttle` cap becomes limit x replicas: login's 5-per-15-minutes is
 * 10 across two pods, and a rollout hands the next attempt a clean count. Bound
 * only in `CLUSTER_MODE=multi`; `single` keeps the library default, which is
 * correct there and costs no write.
 *
 * This is the cheap first gate, not the correctness gate. Every authentication
 * route also carries `auth_attempt_counters` beneath it (task A2), which is a
 * logged table and a deliberate refusal. That is what makes failing **open**
 * here the right trade: a database blip would otherwise turn every guarded
 * request into a 500 raised before the handler decides anything, and readiness
 * already removes a replica that has lost its database.
 *
 * `docs/future-plans/horizontal-scaling.md` (WP2) has the design; the table's
 * `UNLOGGED` rationale is in its migration.
 */
@Injectable()
export class PostgresThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(PostgresThrottlerStorage.name);

  /**
   * When the fail-open path last logged.
   *
   * Process-local on purpose, and not a counter anybody reads: it exists so a
   * database outage produces one line a minute instead of one per request. A
   * log throttle, never a rate limit.
   */
  private lastFailureLoggedAt = 0;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Count one request against `key`, and say whether it is now blocked.
   *
   * `ttl` and `blockDuration` are **milliseconds** (the library's units);
   * `timeToExpire` and `timeToBlockExpire` come back in **seconds**, which is
   * what `ThrottlerGuard` puts in the `Retry-After` header. Both conversions
   * are against the database's own clock, never this process's: two replicas
   * whose clocks differ by a second must not disagree about whether a window
   * has passed.
   *
   * One statement, because the count a caller compares against the limit has to
   * be the count the database wrote. A read-then-write would let two replicas
   * each see "4 of 5" and both allow the fifth.
   *
   * The three `CASE` expressions repeat the same guard sequence because a `SET`
   * list cannot read the value it is assigning, so "what are the hits now" has
   * to be spelled once per column. The sequence, in order:
   *
   *  1. **blocked and still serving it** -- nothing moves. Matching the
   *     library, a blocked key stops accumulating, so hammering through a block
   *     does not extend it.
   *  2. **blocked but the block has lapsed** -- a fresh window at one hit, the
   *     block cleared. The library resets the count here too.
   *  3. **window expired** -- a fresh window at one hit.
   *  4. **otherwise** -- one more hit in the live window, and the block is set
   *     if that hit passed the limit.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    try {
      // The guard runs before RequestContextInterceptor, so there is no ambient
      // identity to inherit -- and this table has no owner to establish one
      // for. runOutsideActiveScopedManager for the reason A2's counter uses it:
      // a count joined to a transaction that then refuses the request would
      // roll back with the refusal, and the limiter would count every attempt
      // as zero. With no ambient transaction it is a no-op.
      const rows = await runOutsideActiveScopedManager(() =>
        withSystemContext(() =>
          withScopedDb(this.dataSource, (manager) =>
            manager.query(
              `INSERT INTO http_throttle_counters AS t
                   (name, key, hits, window_expires_at, blocked_until)
               VALUES (
                 $1, $2, 1,
                 CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval,
                 CASE WHEN 1 > $4
                   THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                   ELSE NULL
                 END
               )
               ON CONFLICT (name, key) DO UPDATE
                  SET hits = CASE
                        WHEN t.blocked_until > CURRENT_TIMESTAMP THEN t.hits
                        WHEN t.blocked_until IS NOT NULL THEN 1
                        WHEN t.window_expires_at < CURRENT_TIMESTAMP THEN 1
                        ELSE t.hits + 1
                      END,
                      window_expires_at = CASE
                        WHEN t.blocked_until > CURRENT_TIMESTAMP THEN t.window_expires_at
                        WHEN t.blocked_until IS NOT NULL
                          OR t.window_expires_at < CURRENT_TIMESTAMP
                          THEN CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval
                        ELSE t.window_expires_at
                      END,
                      blocked_until = CASE
                        WHEN t.blocked_until > CURRENT_TIMESTAMP THEN t.blocked_until
                        WHEN t.blocked_until IS NOT NULL THEN
                          CASE WHEN 1 > $4
                            THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                            ELSE NULL
                          END
                        WHEN t.window_expires_at < CURRENT_TIMESTAMP THEN
                          CASE WHEN 1 > $4
                            THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                            ELSE NULL
                          END
                        WHEN t.hits + 1 > $4
                          THEN CURRENT_TIMESTAMP + ($5::bigint::text || ' milliseconds')::interval
                        ELSE t.blocked_until
                      END
               RETURNING hits AS hits,
                         window_expires_at AS window_expires_at,
                         blocked_until AS blocked_until,
                         CURRENT_TIMESTAMP AS db_now`,
              [
                throttlerName,
                key,
                Math.round(ttl),
                limit,
                Math.round(blockDuration),
              ],
            ),
          ),
        ),
      );

      const [row] = returnedRows<{
        hits: number | string;
        window_expires_at: Date | string;
        blocked_until: Date | string | null;
        db_now: Date | string;
      }>(rows);

      const now = toDate(row.db_now).getTime();
      const blockedUntil =
        row.blocked_until === null ? null : toDate(row.blocked_until).getTime();
      const isBlocked = blockedUntil !== null && blockedUntil > now;

      return {
        totalHits: Number(row.hits),
        timeToExpire: toSeconds(toDate(row.window_expires_at).getTime() - now),
        isBlocked,
        // Zero rather than a negative when nothing is blocked: the guard reads
        // this only while blocked, and a Retry-After of "-1763" would be the
        // kind of header that sends somebody looking for a bug that is not one.
        timeToBlockExpire: isBlocked ? toSeconds(blockedUntil - now) : 0,
      };
    } catch (error) {
      this.reportFailure(error);
      // Fail open. A closed throttler takes the whole API down with the
      // database, before any handler runs, and the readiness probe has already
      // removed this replica from the load balancer. What is lost is one
      // window's leniency on routes whose real refusal is a row elsewhere.
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  /** One line a minute, however many requests are failing. */
  private reportFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastFailureLoggedAt = now;
    this.logger.error(
      `Rate-limit counters are unreachable; the HTTP throttler is failing ` +
        `open until the database returns: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Shortest gap between two fail-open log lines. */
export const FAILURE_LOG_INTERVAL_MS = 60_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Milliseconds to whole seconds, the way `@nestjs/throttler`'s own storage
 * rounds them (`Math.ceil`), so a header this produces matches one the
 * in-process storage would have produced for the same instant.
 */
function toSeconds(milliseconds: number): number {
  return Math.ceil(milliseconds / 1000);
}
