/**
 * The two movements inside a window that the external-flow classifier cannot
 * count, loaded once and read per window.
 *
 * The predicates themselves are documented in
 * `docs/specs/portfolio-period-result.md` section 6.1: an investment action
 * settled outside the cash the valuation walks, and a split parent mixing an
 * investment line with ordinary cash. Both raise or lower the value without the
 * market having moved, so a count above zero withholds the period's result
 * rather than shrinking it.
 *
 * They live here rather than inside `PortfolioPeriodResultService` because two
 * services ask the same question over the same window: the single-range route
 * asks for the whole window at once, and the batch route asks for one wide
 * window and then reads each preset's slice out of the per-day rows. Two
 * spellings of these predicates would be two answers to "is this period
 * measurable", which is the disagreement these endpoints exist to prevent.
 */
import { investmentLinkedSplitExclusion } from "../common/investment-filter.util";
import { LEDGER_TOP_LEVEL_ONLY } from "../common/ledger-balance.sql";
import { UnmeasuredFlowCounts } from "./portfolio-period-result.util";

/** Runs one parameterized statement; supplied by the caller's scoped door. */
export type UnmeasuredFlowQuery = (
  sql: string,
  params: unknown[],
) => Promise<Array<{ date?: string | null; count: string | number }>>;

/** One day's count, or the whole window's when `date` is null. */
export interface UnmeasuredFlowDayCount {
  date: string | null;
  count: number;
}

/** The two causes, each as the rows the loader was asked for. */
export interface UnmeasuredFlowRows {
  externallySettledTrades: UnmeasuredFlowDayCount[];
  mixedSplitParents: UnmeasuredFlowDayCount[];
}

export interface UnmeasuredFlowOptions {
  userId: string;
  /** Exclusive: a movement dated here is already inside MV(b). */
  afterDate: string;
  throughDate: string;
  /** Every account the valuation walks. */
  scope: string[];
  /** The subset whose ledger cash the valuation values. */
  cashScope: string[];
  /** One row per day instead of one row for the window. */
  perDay?: boolean;
}

/**
 * `TO_CHAR(..., 'YYYY-MM-DD')`, never `::TEXT`: the caller compares this string
 * with `YYYY-MM-DD` dates, and a DATE rendered through the session's DateStyle
 * is not obliged to be that.
 */
function dayColumn(perDay: boolean, alias: string): string {
  return perDay
    ? `TO_CHAR(${alias}.transaction_date, 'YYYY-MM-DD') AS date, `
    : "NULL::TEXT AS date, ";
}

function groupBy(perDay: boolean, alias: string): string {
  return perDay ? `GROUP BY ${alias}.transaction_date` : "";
}

/**
 * Investment actions in the window whose settlement cash is outside the set the
 * valuation walks -- including one that moved shares with no cash leg at all and
 * no linked leg inside the scope.
 */
export function externallySettledTradesSql(perDay: boolean): string {
  // $1 userId, $2 afterDate, $3 throughDate, $4 scope, $5 cashScope.
  return `SELECT ${dayColumn(perDay, "it")}COUNT(*) AS count
           FROM investment_transactions it
          WHERE it.user_id = $1
            AND it.account_id = ANY($4::UUID[])
            AND it.transaction_date > $2
            AND it.transaction_date <= $3
            AND it.status != 'VOID'
            AND (
              (
                it.funding_account_id IS NOT NULL
                AND NOT (it.funding_account_id = ANY($5::UUID[]))
              )
              OR EXISTS (
                SELECT 1 FROM transactions ct
                 WHERE ct.id = it.transaction_id
                   AND NOT (ct.account_id = ANY($5::UUID[]))
              )
              OR EXISTS (
                SELECT 1 FROM transaction_splits s
                  JOIN transactions pt ON pt.id = s.transaction_id
                 WHERE s.id = it.transaction_split_id
                   AND NOT (pt.account_id = ANY($5::UUID[]))
              )
              OR (
                it.transaction_id IS NULL
                AND it.transaction_split_id IS NULL
                AND it.action IN (
                  'TRANSFER_IN', 'TRANSFER_OUT', 'ADD_SHARES', 'REMOVE_SHARES'
                )
                AND NOT EXISTS (
                  -- The linked leg is looked up as a record (includes VOID):
                  -- the effect is decided by the row above.
                  SELECT 1 FROM investment_transactions li
                   WHERE li.id = it.linked_transaction_id
                     AND li.account_id = ANY($4::UUID[])
                )
              )
            )
          ${groupBy(perDay, "it")}`;
}

/**
 * Split parents in the window carrying BOTH an investment-linked line and an
 * ordinary one: the flow sum drops such a parent whole, so its ordinary cash is
 * in the value change and in no flow.
 */
export function mixedSplitParentsSql(perDay: boolean): string {
  return `SELECT ${dayColumn(perDay, "t")}COUNT(*) AS count
           FROM transactions t
          WHERE t.user_id = $1
            AND t.account_id = ANY($5::UUID[])
            AND ${LEDGER_TOP_LEVEL_ONLY}
            AND t.transaction_date > $2
            AND t.transaction_date <= $3
            AND t.status IS DISTINCT FROM 'VOID'
            AND EXISTS (
              SELECT 1 FROM transaction_splits s
               WHERE s.transaction_id = t.id
                 AND NOT (${investmentLinkedSplitExclusion("s")})
            )
            AND EXISTS (
              SELECT 1 FROM transaction_splits s
               WHERE s.transaction_id = t.id
                 AND ${investmentLinkedSplitExclusion("s")}
            )
          ${groupBy(perDay, "t")}`;
}

/**
 * Both counts for one window. `COUNT(*)` comes back as a string from the
 * driver, so it is coerced at this boundary.
 */
export async function loadUnmeasuredFlowRows(
  query: UnmeasuredFlowQuery,
  options: UnmeasuredFlowOptions,
): Promise<UnmeasuredFlowRows> {
  const perDay = options.perDay === true;
  const params: unknown[] = [
    options.userId,
    options.afterDate,
    options.throughDate,
    options.scope,
    options.cashScope,
  ];

  const toRows = (
    rows: Array<{ date?: string | null; count: string | number }>,
  ): UnmeasuredFlowDayCount[] =>
    (rows ?? []).map((row) => ({
      date: row.date ?? null,
      count: Number(row.count ?? 0),
    }));

  const [settled, mixed] = await Promise.all([
    query(externallySettledTradesSql(perDay), params),
    query(mixedSplitParentsSql(perDay), params),
  ]);

  return {
    externallySettledTrades: toRows(settled),
    mixedSplitParents: toRows(mixed),
  };
}

/**
 * The counts for the part of the loaded window that lies strictly after
 * `afterDate`, which is how a preset reads its own slice out of one wide load.
 *
 * A row with no date is the whole window's total and belongs to every slice of
 * it: a loader asked for totals cannot say which day a movement fell on, and
 * dropping it would report a window as measurable on the strength of a count
 * that was never taken per day.
 */
export function unmeasuredFlowsAfter(
  rows: UnmeasuredFlowRows,
  afterDate?: string,
): UnmeasuredFlowCounts {
  const sum = (entries: UnmeasuredFlowDayCount[]) =>
    entries.reduce(
      (total, entry) =>
        entry.date === null || afterDate === undefined || entry.date > afterDate
          ? total + entry.count
          : total,
      0,
    );

  return {
    externallySettledTrades: sum(rows.externallySettledTrades),
    mixedSplitParents: sum(rows.mixedSplitParents),
  };
}
