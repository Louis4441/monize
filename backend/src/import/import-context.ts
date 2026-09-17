import { EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { roundMoney } from "../common/round.util";
import { ImportResultDto } from "./dto/import.dto";

export interface ImportContext {
  manager: EntityManager;
  userId: string;
  accountId: string;
  account: Account;
  categoryMap: Map<string, string | null>;
  accountMap: Map<string, string | null>;
  loanCategoryMap: Map<string, string>;
  securityMap: Map<string, string | null>;
  /** Maps tag name (case-insensitive key) to tag ID */
  tagMap: Map<string, string>;
  importStartTime: Date;
  dateCounters: Map<string, number>;
  affectedAccountIds: Set<string>;
  importResult: ImportResultDto;
  /** Tracks how many QIF entries with each transfer signature have been seen in the current block,
   *  used to distinguish genuinely different transfers that share date/amount/account. */
  transferDupCounts: Map<string, number>;
}

/**
 * Move an account's balance by `amount`, as the atomic delta every balance
 * writer in this codebase uses (`docs/concurrency-and-idempotency.md` section 2,
 * row 1; the same statement as `AccountsService.updateBalance`).
 *
 * One statement, so the read and the write cannot be interleaved: a second
 * delta committing in between composes instead of being overwritten, which a
 * `findOne` followed by an absolute `update` could not promise. The `UPDATE`
 * row-locks `accounts` exactly where the previous one did, so the import's lock
 * order (the `lockHoldingScope` advisory lock is the transaction's first
 * statement) is unchanged.
 *
 * The delta itself is rounded through `roundMoney` (4dp, the column's
 * precision); the sum is rounded by the database. A row that does not exist is
 * a no-op, as before.
 */
export async function updateAccountBalance(
  manager: EntityManager,
  accountId: string,
  amount: number,
): Promise<void> {
  const delta = roundMoney(Number(amount) || 0);
  await manager.query(
    `UPDATE accounts
        SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4)
      WHERE id = $2`,
    [delta, accountId],
  );
}
