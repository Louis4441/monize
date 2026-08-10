import { SelectQueryBuilder } from "typeorm";

/**
 * SQL fragments for analytics queries that must attribute amounts and
 * categories to individual splits rather than the split parent.
 *
 * A split parent has `category_id = NULL` and `amount = SUM(splits)`,
 * so querying the parent row directly reports split transactions as
 * uncategorized and double-counts income/expense direction. The
 * caller must LEFT JOIN the splits (and optionally the split's
 * category) via `joinSplitsForAnalytics` before using these.
 */
export const SPLIT_CATEGORY_ID = "COALESCE(ts.categoryId, t.categoryId)";
export const SPLIT_AMOUNT = "COALESCE(ts.amount, t.amount)";

/**
 * There is deliberately no category-*name* fragment here.
 *
 * A leaf name does not identify a category -- "Cell Phone" lives under both
 * "Bills" and "Business" in an ordinary chart of accounts -- so selecting or
 * grouping on `splitCat.name` merges two categories into one row and labels the
 * result ambiguously. Group on {@link SPLIT_CATEGORY_ID} and resolve the label
 * through `loadQualifiedCategoryNames` (`categories/category-name.util.ts`),
 * which is the same definition the tools use to resolve a name the model sends
 * back. `transaction-split-query.util.spec.ts` fails if a name fragment
 * reappears here.
 */

/**
 * LEFT JOIN the splits table and the split's category, then exclude
 * transfer splits.
 *
 * Callers must use `t` as the transaction alias. Aliases `ts` and
 * `splitCat` are reserved for this helper.
 */
export function joinSplitsForAnalytics<T extends object>(
  qb: SelectQueryBuilder<T>,
): SelectQueryBuilder<T> {
  qb.leftJoin("t.splits", "ts");
  qb.leftJoin("ts.category", "splitCat");
  qb.andWhere("(ts.transferAccountId IS NULL OR ts.id IS NULL)");
  return qb;
}
