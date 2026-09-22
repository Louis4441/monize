import { ObjectLiteral, SelectQueryBuilder } from "typeorm";

/**
 * The order the register lists transactions in, written once.
 *
 * Four queries have to agree on it, and only one of them is the register: the
 * other three sum the rows on *previous pages* so page N's running balance can
 * start from the right number. A tiebreak added to the register alone silently
 * re-splits the pages under those sums, and every balance from page 2 down is
 * wrong by whichever rows crossed the boundary. That is the "a predicate that
 * decides which row counts is written once" rule applied to an ORDER BY.
 *
 * ## Why `amount` is in here
 *
 * `created_at` defaults to `CURRENT_TIMESTAMP`, which in PostgreSQL is
 * **transaction start time** -- one value for the whole transaction, not per
 * statement. TypeORM leans on that default rather than sending a value
 * (`InsertQueryBuilder` says so in a comment where the code used to be), so
 * every row an import writes carries the *same* `created_at`. Within one date
 * the order then fell through to `id`, which is a random UUID: the register
 * listed same-day imported rows in an arbitrary order that changed nothing
 * about the stored balance and everything about the running balance beside it.
 *
 * The visible symptom is an account that appears to go overdrawn. A purchase
 * funded by a transfer that same day is two rows in the cash account, and if
 * the debit is ordered as the older of the two, the running balance dips
 * negative on a day the account was never short. It recovers on the next row,
 * which is what makes it read as a bug in the balance rather than in the sort.
 *
 * So when the clock cannot separate two rows, their signs do: **credits are
 * ordered before debits**, chronologically. Money has to arrive before it can
 * be spent, and no data we hold says otherwise -- `.mny`, QIF and OFX all carry
 * a date and no time.
 *
 * The tiebreak runs **opposite** to the list direction, which is the one part
 * that looks wrong and is not. The rule is about chronological order, and a
 * descending register lists newest first: putting credits earlier in time means
 * putting them *later* in a newest-first list. Deriving it from `direction`
 * rather than hardcoding `ASC` is what keeps an ascending register right too.
 *
 * It only ever changes anything when `created_at` ties, so ordinary
 * hand-entered rows -- which are seconds apart -- are untouched.
 */

export type RegisterSortDirection = "ASC" | "DESC";

/**
 * The columns the register can be sorted by, written once.
 *
 * This list is the contract between four places: the register query, the
 * HTTP query parameter, the AI and MCP tools, and the browser's column
 * headers. A contract spec holds the browser's copy equal to
 * this one, and the tool schemas derive their enums from it, so a field
 * offered anywhere is a field every caller can ask for.
 *
 * What is NOT here is as deliberate as what is. Tags and attachments are
 * one-to-many joins: ordering by one makes the DISTINCT-id query TypeORM
 * pages these joins with emit an id per joined row, and a page repeats
 * transactions. Balance is derived per page rather than stored. The
 * foreign-currency columns belong to one surface's feature set.
 */
export const TRANSACTION_SORT_FIELDS = [
  "date",
  "account",
  "payee",
  "category",
  "description",
  "refNumber",
  "amount",
  "status",
] as const;

export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];

export const DEFAULT_TRANSACTION_SORT_FIELD: TransactionSortField = "date";
export const DEFAULT_TRANSACTION_SORT_DIRECTION: RegisterSortDirection = "DESC";

export function isTransactionSortField(
  value: unknown,
): value is TransactionSortField {
  return (
    typeof value === "string" &&
    (TRANSACTION_SORT_FIELDS as readonly string[]).includes(value)
  );
}

/**
 * The aliases of the joined tables a sort field may order by.
 *
 * A query that does not join them cannot be asked for those fields, and
 * `registerPrimaryOrder` throws rather than emitting SQL naming an alias that
 * is not in the statement. The three queries that sum the rows newer than a
 * page select from `transactions` alone and pass nothing here, so they can
 * never be ordered by a joined column -- which is what keeps their window
 * comparable with the register's own.
 */
export interface RegisterSortAliases {
  account?: string;
  category?: string;
}

/**
 * A primary ORDER BY term: the expression, and where the nulls go when the
 * column is nullable.
 *
 * Nulls sink in BOTH directions rather than riding the sort, because a blank
 * payee, category, description or reference is the absence of a value, not
 * the smallest one: reversing the sort should not fill the top of the
 * register with rows that have nothing in the column being sorted by. It is
 * also what `compareValues` (the client's sort helper) already does.
 */
export interface RegisterPrimaryOrder {
  expression: string;
  nulls?: "NULLS LAST";
}

function requireJoinAlias(
  alias: string | undefined,
  field: TransactionSortField,
): string {
  if (!alias) {
    throw new Error(
      `Sorting the register by "${field}" needs that table's join alias. ` +
        "Pass it in `aliases`, or do not offer the field on a query that " +
        "does not join the table.",
    );
  }
  return alias;
}

/**
 * The primary ORDER BY term for a sort field.
 *
 * The expression is always `alias.property`, never a computed one: TypeORM
 * pages a query with joins by selecting DISTINCT ids plus the order columns
 * from a subquery, and it rewrites each order key by splitting on the dot and
 * resolving the alias. A `CASE` or `LOWER(...)` there is not an alias, so it
 * throws. That is why status sorts by its stored value rather than by a
 * lifecycle rank: the rank would have to be an added select, which is a
 * bigger change than a status sort is worth.
 *
 * Text sorts in the database collation for the same reason `categories` and
 * `payees` already order by a raw `name`: one collation, one answer, and no
 * expression in the ORDER BY.
 */
export function registerPrimaryOrder(
  field: TransactionSortField,
  transactionAlias: string,
  aliases?: RegisterSortAliases,
): RegisterPrimaryOrder {
  switch (field) {
    case "date":
      return { expression: `${transactionAlias}.transactionDate` };
    case "amount":
      return { expression: `${transactionAlias}.amount` };
    case "status":
      return { expression: `${transactionAlias}.status` };
    case "payee":
      return {
        expression: `${transactionAlias}.payeeName`,
        nulls: "NULLS LAST",
      };
    case "description":
      return {
        expression: `${transactionAlias}.description`,
        nulls: "NULLS LAST",
      };
    case "refNumber":
      return {
        expression: `${transactionAlias}.referenceNumber`,
        nulls: "NULLS LAST",
      };
    case "account":
      return {
        expression: `${requireJoinAlias(aliases?.account, field)}.name`,
        nulls: "NULLS LAST",
      };
    case "category":
      return {
        expression: `${requireJoinAlias(aliases?.category, field)}.name`,
        nulls: "NULLS LAST",
      };
  }
}

/**
 * Chronological order within a `created_at` tie is credits first, so a
 * newest-first list needs debits first. Exported so the guard test can state
 * the relationship rather than restate the table.
 */
export function creditsBeforeDebitsDirection(
  direction: RegisterSortDirection,
): RegisterSortDirection {
  return direction === "DESC" ? "ASC" : "DESC";
}

/**
 * Applies the register's full ordering to a query builder.
 *
 * @param field The column the reader chose, defaulting to the transaction
 *   date. Under any other field the transaction date becomes the second key,
 *   so one payee's (or one category's, or one status's) rows still read
 *   chronologically instead of in the order they happened to be imported in.
 *   The tiebreaks below that are the same whatever the field.
 * @param aliases The join aliases for the fields that order by another table.
 */
export function applyRegisterOrder<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string,
  direction: RegisterSortDirection,
  field: TransactionSortField = DEFAULT_TRANSACTION_SORT_FIELD,
  aliases?: RegisterSortAliases,
): SelectQueryBuilder<T> {
  const primary = registerPrimaryOrder(field, alias, aliases);
  queryBuilder.orderBy(primary.expression, direction, primary.nulls);
  if (field !== "date") {
    queryBuilder.addOrderBy(`${alias}.transactionDate`, direction);
  }
  return queryBuilder
    .addOrderBy(`${alias}.createdAt`, direction)
    .addOrderBy(`${alias}.amount`, creditsBeforeDebitsDirection(direction))
    .addOrderBy(`${alias}.id`, direction);
}
