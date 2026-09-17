import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { affectedRowCount } from "../common/db/query-result";

/**
 * Daily collection of the two auth state tables' dead rows.
 *
 * `auth_attempt_counters` and `single_use_tokens` are both written on paths
 * that never come back to tidy up: nobody returns to clear a counter for an
 * email address that stopped being attacked, and a TOTP code is dead the moment
 * its window passes whether or not anyone tried to reuse it. Without a sweep
 * they are append-only.
 *
 * **The sweep is not what makes either table correct.** An expired counter is
 * already ignored by the incrementing statement, which resets the window in
 * place, and a claim against an expired `single_use_tokens` row is still a
 * loss. Deleting late is therefore safe; deleting early would not be, which is
 * why the predicate is the stored expiry and never a clock this process holds.
 *
 * Idempotent by predicate, so every replica firing this cron
 * (`docs/cron-jobs.md`: they all do, in both cluster modes) deletes the same
 * rows and the losers delete none.
 */
@Injectable()
export class AuthStateSweeperService {
  private readonly logger = new Logger(AuthStateSweeperService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron("0 4 * * *")
  async sweepExpiredAuthState(): Promise<void> {
    try {
      const { counters, tokens } = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) => {
          const counterResult: unknown = await manager.query(
            `DELETE FROM auth_attempt_counters
              WHERE window_expires_at < CURRENT_TIMESTAMP`,
          );
          const tokenResult: unknown = await manager.query(
            `DELETE FROM single_use_tokens
              WHERE expires_at < CURRENT_TIMESTAMP`,
          );
          return {
            counters: affectedRowCount(counterResult),
            tokens: affectedRowCount(tokenResult),
          };
        }),
      );
      if (counters > 0 || tokens > 0) {
        this.logger.log(
          `Swept ${counters} expired attempt counter(s) and ${tokens} expired single-use token(s)`,
        );
      }
    } catch (error) {
      // Warned and swallowed, like the other expiry sweeps: nothing depends on
      // this run having happened, and a throw out of a cron handler is an
      // unhandled rejection rather than a report anyone reads.
      this.logger.warn(
        `Auth state sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
