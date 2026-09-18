/**
 * What crossed the boundary of the INVESTED part, per day and per currency.
 *
 * The sibling of `external-flow.util.ts`, drawn around a different boundary.
 * That one asks "did cash cross the edge of the portfolio", so a BUY, a SELL
 * and a DIVIDEND are internal to it. This one asks "did value enter or leave
 * the securities", so those same rows ARE the flows: a purchase moves a
 * reader's cash into the invested part and is not a gain, a sale moves it out
 * and is not a loss, and a distribution is what the invested part earned.
 * `docs/specs/portfolio-period-result.md` section 10.2 is the definition.
 *
 * Three rules this file exists to keep:
 *
 * - **The action classification is not restated here.** Which action is
 *   capital in, capital out, income or nothing is `INVESTED_FLOW_KIND_BY_BASE_ACTION`
 *   (`securities/investment-replay.util.ts`), checked against the enum by a
 *   spec. The SQL groups by raw action and the fold below asks that constant,
 *   so a new action cannot become a silent zero in a capital flow.
 * - **Rows as effects.** A VOID investment transaction moved no shares and no
 *   value, through the shared predicate (`investmentEffectStatusSql`).
 * - **Each day at its own rate.** A row is recorded in its security's currency
 *   and converted at the rate that stood on its own day, through the same
 *   `RateIndex` the value series and the external-flow fold use (INV-FX-001).
 *   A day that would not convert makes that day incomplete, which withholds the
 *   period's figures rather than shrinking them.
 */
import { FxAggregate } from "../common/fx-aggregate";
import {
  RateIndex,
  RateIndexLogger,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { returnedRows } from "../common/db/query-result";
import { actionCarriesTotal } from "../securities/investment-amount.util";
import { investedFlowKind } from "../securities/investment-replay.util";
import { investmentEffectStatusSql } from "../securities/investment-row-effects.util";
import { SeriesRateGap } from "./series-rate-fill";

/** One day's subtotal for one currency and one action, as the loader returns it. */
export interface InvestedFlowRow {
  date: string;
  currency: string;
  action: string;
  /** Sum of the executed totals, for the actions that carry one. */
  total: number;
  /** Sum of `quantity * price`, for the share-moving legs that do not. */
  gross: number;
}

export interface InvestedFlowQueryOptions {
  userId: string;
  /** Exclusive lower bound: rows strictly AFTER this date, as IV(b) holds it. */
  afterDate: string;
  /** Inclusive upper bound. */
  throughDate: string;
  /** Every account of the scope; investment rows live on its brokerage sleeves. */
  accountIds: string[];
}

/** Runs one parameterized statement; supplied by the caller's scoped door. */
export type InvestedFlowQuery = (
  sql: string,
  params: unknown[],
) => Promise<unknown>;

/**
 * The SQL for one capital-and-income read. Exported so a spec can assert the
 * predicate and the bindings without a database.
 *
 * `total_amount` is stored in the security's currency, commission in on an
 * acquisition and out on a disposal (`deriveInvestmentTotal`), which is the
 * cost-basis convention the invested part measures in. The share-moving legs
 * carry no total at all, so their value is `quantity * price` -- the carried
 * basis, the same expression the first-active-month cost basis reads. Both
 * sums come back per action and the fold picks which one the action means, so
 * the action vocabulary stays in TypeScript where the constant that defines it
 * lives.
 */
export function investedCapitalFlowSql(): string {
  // $1 userId, $2 afterDate, $3 throughDate, $4 accountIds. Every placeholder
  // this statement names is bound and no other: an unreferenced parameter is a
  // type PostgreSQL cannot infer, and it refuses at PARSE.
  return `SELECT TO_CHAR(it.transaction_date, 'YYYY-MM-DD') AS date,
                 COALESCE(s.currency_code, a.currency_code) AS currency,
                 it.action AS action,
                 SUM(ABS(COALESCE(it.total_amount, 0))) AS total,
                 SUM(ABS(COALESCE(it.quantity, 0) * COALESCE(it.price, 0))) AS gross
            FROM investment_transactions it
            JOIN accounts a ON a.id = it.account_id
            LEFT JOIN securities s ON s.id = it.security_id
           WHERE it.user_id = $1
             AND it.account_id = ANY($4::UUID[])
             AND it.transaction_date > $2
             AND it.transaction_date <= $3
             -- Rows as EFFECTS: renders it.status != 'VOID', because a void
             -- investment row moved no shares and no value.
             AND ${investmentEffectStatusSql("it")}
           GROUP BY it.transaction_date, COALESCE(s.currency_code, a.currency_code), it.action`;
}

/**
 * The scope's capital and income rows for the window, subtotalled per day,
 * currency and action. Conversion is the caller's, through `foldInvestedFlows`.
 */
export async function loadInvestedCapitalFlowRows(
  query: InvestedFlowQuery,
  options: InvestedFlowQueryOptions,
): Promise<InvestedFlowRow[]> {
  // An empty scope is a scope nothing is in, and it must total nothing.
  if (options.accountIds.length === 0) return [];

  const rows = returnedRows<{
    date: string;
    currency: string;
    action: string;
    total: string;
    gross: string;
  }>(
    await query(investedCapitalFlowSql(), [
      options.userId,
      options.afterDate,
      options.throughDate,
      options.accountIds,
    ]),
  );

  return rows.map((row) => ({
    date: row.date,
    currency: row.currency,
    action: row.action,
    total: Number(row.total) || 0,
    gross: Number(row.gross) || 0,
  }));
}

/** One day of the invested part's flows, in the reporting currency. */
export interface InvestedFlowDay {
  /** Value paid INTO the securities: it funds the day, it is not a gain. */
  capitalIn: number;
  /** Value taken OUT of them: it is what the position came to, not a loss. */
  capitalOut: number;
  /** Cash the invested part paid out, and therefore earned. */
  income: number;
  /** False when a component of this day could not be converted. */
  complete: boolean;
  /** `"EUR->USD"` for each pair with no rate on this day. */
  missingPairs: string[];
}

export interface FoldedInvestedFlows {
  /** Keyed by `YYYY-MM-DD`; a day with no rows is simply absent. */
  byDay: Map<string, InvestedFlowDay>;
  /** The per-day gaps the read-path rate fill plans a provider fetch from. */
  gaps: SeriesRateGap[];
}

/** An empty day: no capital moved, no income arrived, and that is known. */
export const EMPTY_INVESTED_FLOW_DAY: InvestedFlowDay = {
  capitalIn: 0,
  capitalOut: 0,
  income: 0,
  complete: true,
  missingPairs: [],
};

/**
 * The rows folded per day into the reporting currency.
 *
 * Folded per DAY rather than per window so a preset reads its own slice out of
 * one wide load without re-folding: a day is the same day whatever window was
 * asked for, which is what makes the batch route's answers identical to the
 * single-range route's (section 10.7).
 */
export function foldInvestedFlows(
  rows: readonly InvestedFlowRow[],
  currency: string,
  rateIndex: RateIndex,
  logger: RateIndexLogger,
): FoldedInvestedFlows {
  const aggregates = new Map<
    string,
    { in: FxAggregate; out: FxAggregate; income: FxAggregate }
  >();
  const gaps: SeriesRateGap[] = [];

  for (const row of rows) {
    const kind = investedFlowKind(row.action);
    if (kind === "none") continue;
    // The executed total is the fact where the action carries one; the
    // share-moving legs have none, so their value is what the row priced them
    // at. Neither is ever defaulted to something else: a zero total on a
    // priceless leg contributes zero and the window's uncountable-movement
    // count is what withholds it (section 10.6, open item 1).
    const amount = actionCarriesTotal(row.action) ? row.total : row.gross;
    if (amount === 0) continue;

    let entry = aggregates.get(row.date);
    if (!entry) {
      entry = {
        in: new FxAggregate(),
        out: new FxAggregate(),
        income: new FxAggregate(),
      };
      aggregates.set(row.date, entry);
    }
    const target =
      kind === "capitalIn"
        ? entry.in
        : kind === "capitalOut"
          ? entry.out
          : entry.income;

    if (row.currency === currency) {
      target.addConverted(amount);
      continue;
    }
    const converted = convertAtDate(
      amount,
      row.currency,
      currency,
      row.date,
      rateIndex,
      logger,
    );
    if (converted === null) {
      gaps.push({
        date: row.date,
        missingRatePairs: [`${row.currency}->${currency}`],
      });
    }
    target.add(converted, row.currency, currency);
  }

  const byDay = new Map<string, InvestedFlowDay>();
  for (const [date, entry] of aggregates) {
    const missing = new Set<string>([
      ...entry.in.missingPairs,
      ...entry.out.missingPairs,
      ...entry.income.missingPairs,
    ]);
    byDay.set(date, {
      capitalIn: entry.in.knownSubtotal,
      capitalOut: entry.out.knownSubtotal,
      income: entry.income.knownSubtotal,
      complete:
        entry.in.isComplete && entry.out.isComplete && entry.income.isComplete,
      missingPairs: [...missing].sort(),
    });
  }

  return { byDay, gaps };
}
