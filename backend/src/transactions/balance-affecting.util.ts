import { SelectQueryBuilder } from "typeorm";
import { TransactionStatus } from "./entities/transaction.entity";

/**
 * Restricts a query to the rows that actually move an account balance.
 *
 * `AccountsService.getProjectedBalance` is the canonical definition -- opening
 * balance plus every transaction that is neither VOID nor a split child -- and
 * the register's running balance skips exactly those two kinds as it walks down
 * the page. Any sum that is *subtracted from* a projected balance has to use the
 * same rule, or the two disagree by whatever it counted and the projection did
 * not.
 *
 * That is not hypothetical. The register's page-2-and-beyond starting balance
 * subtracted a plain `SUM(amount)` over the rows above the page, VOID rows
 * included, so a Money import carrying 31 voided cheques shifted every earlier
 * page by their total: an account opening at -$580.42 whose first transaction is
 * a $200 payment showed -$307.20 instead of -$380.42, off by the -$73.22 of
 * voids sitting higher up the register.
 *
 * Prefer this helper to hand-writing the predicate, so a fifth sum cannot drift
 * from the other four.
 */
export function onlyBalanceAffecting<T extends object>(
  qb: SelectQueryBuilder<T>,
  alias: string,
): SelectQueryBuilder<T> {
  return qb
    .andWhere(
      `(${alias}.status IS NULL OR ${alias}.status != :balanceAffectingVoid)`,
      { balanceAffectingVoid: TransactionStatus.VOID },
    )
    .andWhere(`${alias}.parentTransactionId IS NULL`);
}
