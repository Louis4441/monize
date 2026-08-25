import { SelectQueryBuilder } from "typeorm";

/**
 * Which transaction rows are an investment movement rather than ordinary cash,
 * written once for every reader.
 *
 * An INVESTMENT account in Monize is a PAIR (`accounts.service.ts`
 * `createInvestmentAccountPair`): an `INVESTMENT_CASH` sleeve holding real
 * money and an `INVESTMENT_BROKERAGE` sleeve holding securities, both carrying
 * `account_type = 'INVESTMENT'`. So `account_type != 'INVESTMENT'` is not a
 * filter on synthetic rows -- it deletes the cash sleeve's entire ledger,
 * salary deposits included (issue #1257).
 *
 * Two layers, and neither substitutes for the other:
 *
 *  - `accountSubType != 'INVESTMENT_BROKERAGE'` keeps the securities sleeve's
 *    register out of a cash report. A standalone investment account (subtype
 *    NULL, as .mny imports produce) IS its own cash side, so it stays in.
 *  - `NOT EXISTS (investment_transactions ...)` catches the cash-side rows that
 *    BUY / SELL / DIVIDEND post into the linked cash account
 *    (`createCashTransactionInTransaction`). Those carry no category and no
 *    transfer flag, and the subtype filter cannot see them at all -- untreated
 *    they leak into "spending" and "income" totals as uncategorised money.
 *
 * The split fragment is the same fact one level down: an investment embedded in
 * a split (`transaction_splits.kind = 'investment'`) has `category_id IS NULL`,
 * so a report grouping on `COALESCE(ts.category_id, t.category_id)` files that
 * line under Uncategorized unless it is excluded here.
 *
 * A raw-SQL caller and a QueryBuilder caller need the same predicate spelled
 * with different column names, so both are derived from one definition below
 * rather than written twice.
 */
const BROKERAGE_SUB_TYPE = "INVESTMENT_BROKERAGE";

/** The sub-type column, in each dialect that has to name it. */
const SUB_TYPE_FIELD = {
  /** TypeORM QueryBuilder: entity property names. */
  entity: "accountSubType",
  /** Raw SQL: physical column names. */
  column: "account_sub_type",
} as const;

function brokerageExclusion(accountAlias: string, field: string): string {
  return `(${accountAlias}.${field} IS NULL OR ${accountAlias}.${field} != '${BROKERAGE_SUB_TYPE}')`;
}

/** Brokerage-sleeve exclusion for a TypeORM QueryBuilder condition. */
export function brokerageExclusionForEntity(accountAlias: string): string {
  return brokerageExclusion(accountAlias, SUB_TYPE_FIELD.entity);
}

/** Brokerage-sleeve exclusion for raw SQL. */
export function brokerageExclusionForSql(accountAlias: string): string {
  return brokerageExclusion(accountAlias, SUB_TYPE_FIELD.column);
}

/**
 * Excludes the cash leg an investment transaction generated. Identical in both
 * dialects: it names a physical table and the transaction row's `id`.
 *
 * Deliberately `includes VOID` rows: this reads what a row IS -- its identity --
 * not what it moved.
 */
export function investmentLinkedTransactionExclusion(
  transactionAlias: string,
): string {
  return `NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = ${transactionAlias}.id)`;
}

/** Excludes an investment line embedded in a split transaction. */
export function investmentLinkedSplitExclusion(splitAlias: string): string {
  return `NOT EXISTS (SELECT 1 FROM investment_transactions its WHERE its.transaction_split_id = ${splitAlias}.id)`;
}

/**
 * The conjunction a raw-SQL report inserts in place of the old
 * `AND a.account_type != 'INVESTMENT'`. Carries no bound parameters, so a
 * call site's `$n` numbering is unaffected.
 *
 * Omit `accountAlias` where the query has already scoped its accounts (or
 * genuinely wants the brokerage sleeve in); omit `splitAlias` where the query
 * does not join `transaction_splits`.
 */
export function investmentExclusionSql(opts: {
  accountAlias?: string;
  transactionAlias: string;
  splitAlias?: string;
}): string {
  const clauses: string[] = [];
  if (opts.accountAlias) {
    clauses.push(brokerageExclusionForSql(opts.accountAlias));
  }
  clauses.push(investmentLinkedTransactionExclusion(opts.transactionAlias));
  if (opts.splitAlias) {
    clauses.push(investmentLinkedSplitExclusion(opts.splitAlias));
  }
  return clauses.join("\n        AND ");
}

/**
 * The QueryBuilder form of the same two layers. Callers must have joined the
 * account alias first. The transaction alias defaults to `transaction`.
 */
export function applyInvestmentTransactionFilters<T extends object>(
  qb: SelectQueryBuilder<T>,
  accountAlias: string,
  transactionAlias: string = "transaction",
): SelectQueryBuilder<T> {
  qb.andWhere(brokerageExclusionForEntity(accountAlias));
  qb.andWhere(investmentLinkedTransactionExclusion(transactionAlias));
  return qb;
}
