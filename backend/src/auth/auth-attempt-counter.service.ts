import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";

/**
 * Every rate-limit and lockout counter the auth layer keeps, on rows.
 *
 * What this replaces was a `Map` per limiter per process. That is two defects
 * wearing one field: two replicas enforce "three attempts" twice, and a restart
 * -- a rollout, a crash, an OOM kill -- hands an attacker a fresh allowance for
 * free. A row fixes both, because the increment below is one statement and the
 * database decides the order.
 *
 * Scopes and keys are the contract between replicas: two processes must spell a
 * limiter the same way or they are counting different things. Callers pass a
 * literal scope and a key that is already opaque -- `sha256(email)`,
 * `sha256(tempToken)`, a user id. Never the secret itself: this table has no
 * owner column and is RLS-exempt, so a raw key would be readable by every
 * session (`docs/row-level-security-contract.md`).
 */
@Injectable()
export class AuthAttemptCounterService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Count one failure and return the window's running total.
   *
   * One statement, so the count a caller compares against its threshold is the
   * count the database wrote, not a read another replica has already
   * invalidated. An expired window is reset in place rather than deleted: a row
   * past `window_expires_at` restarts at 1 and moves its window, which is what
   * makes the daily sweep (`AuthStateSweeperService`) a collection of garbage
   * and never a part of the limit.
   *
   * **It runs outside the caller's transaction, deliberately.** A failure
   * counter exists to be recorded on the path that then *refuses* the request,
   * and a refusal usually throws -- so an increment joined to the caller's
   * transaction would roll back with it, and the limiter would count every
   * attempt as zero. `runOutsideActiveScopedManager` gives this statement its
   * own connection and its own commit; with no ambient transaction (the login
   * and 2FA paths have none) it is a no-op. The cost is one pooled connection
   * for the length of one statement, on a path that is already failing.
   */
  async increment(
    scope: string,
    key: string,
    windowMs: number,
  ): Promise<{ count: number; windowExpiresAt: Date }> {
    const rows = await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO auth_attempt_counters (scope, key, count, window_expires_at)
           VALUES ($1, $2, 1, CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval)
           ON CONFLICT (scope, key) DO UPDATE
              SET count = CASE
                    WHEN auth_attempt_counters.window_expires_at < CURRENT_TIMESTAMP THEN 1
                    ELSE auth_attempt_counters.count + 1
                  END,
                  window_expires_at = CASE
                    WHEN auth_attempt_counters.window_expires_at < CURRENT_TIMESTAMP
                      THEN CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval
                    ELSE auth_attempt_counters.window_expires_at
                  END
           RETURNING count AS count, window_expires_at AS window_expires_at`,
          [scope, key, Math.round(windowMs)],
        ),
      ),
    );
    const [row] = returnedRows<{
      count: number | string;
      window_expires_at: Date | string;
    }>(rows);
    return {
      count: Number(row.count),
      windowExpiresAt:
        row.window_expires_at instanceof Date
          ? row.window_expires_at
          : new Date(row.window_expires_at),
    };
  }

  /**
   * How many failures the current window holds, or 0 when it has passed.
   *
   * The expiry is compared in SQL rather than against a clock this process
   * holds: two replicas disagreeing by a few seconds would otherwise disagree
   * about whether somebody is locked out.
   */
  async peek(scope: string, key: string): Promise<number> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT count AS count
           FROM auth_attempt_counters
          WHERE scope = $1
            AND key = $2
            AND window_expires_at >= CURRENT_TIMESTAMP`,
        [scope, key],
      ),
    );
    const [row] = returnedRows<{ count: number | string }>(rows);
    return row ? Number(row.count) : 0;
  }

  /** Clear the counter -- what a success does. Missing row is the same answer. */
  async reset(scope: string, key: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `DELETE FROM auth_attempt_counters WHERE scope = $1 AND key = $2`,
        [scope, key],
      ),
    );
  }
}
