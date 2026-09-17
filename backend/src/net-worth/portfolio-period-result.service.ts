import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import { FxAggregate } from "../common/fx-aggregate";
import { investmentLinkedSplitExclusion } from "../common/investment-filter.util";
import {
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { loadExternalFlowSubtotals } from "../securities/external-flow.util";
import {
  UNFILTERED_INVESTMENT_SCOPE_SQL,
  resolveInvestmentScopeAccountIds,
} from "../securities/investment-scope.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NetWorthService, isValuationCashAccount } from "./net-worth.service";
import {
  PeriodResultReason,
  PeriodReturnMethod,
  UnmeasuredFlowCounts,
  decidePeriodResult,
} from "./portfolio-period-result.util";

/** One account of the scope, with what the cash boundary is decided from. */
interface ScopeAccount {
  id: string;
  account_type: string;
  account_sub_type: string | null;
}

export { PeriodResultReason, PeriodReturnMethod };

/** What `GET /net-worth/investments-period-result` answers. */
export interface PortfolioPeriodResult {
  /** The currency every figure below is in. */
  currency: string;
  /** The close the period is measured FROM (the baseline, where one was given). */
  startDate: string;
  /** The close the period is measured TO. */
  endDate: string;
  /** MV(b); null when that day is a subtotal. */
  startValue: number | null;
  /** MV(e); null when that day is a subtotal. */
  endValue: number | null;
  /** `MV(e) - MV(b)`. What the portfolio is worth now, less what it was. */
  valueChange: number | null;
  /** Cash that crossed the scope's boundary after `startDate`, net. */
  netExternalFlows: number | null;
  /** The part of the flow that converted, when the total is withheld. */
  knownFlowSubtotal: number;
  /** `valueChange - netExternalFlows`. What the market did, and nothing else. */
  investmentResult: number | null;
  /** The result over the starting value; see `returnMethod`. */
  returnPercent: number | null;
  returnMethod: PeriodReturnMethod;
  /** True only when every figure above is known, the percentage included. */
  complete: boolean;
  reasons: PeriodResultReason[];
  missingRatePairs: string[];
  unpricedSecurityIds: string[];
  unknownCashAccountIds: string[];
}

/**
 * What a portfolio did over a period, net of the money its owner put in.
 *
 * The report used to print `last - first` over the value series and a percentage
 * of the first point, so two deposits with a price that never moved read as a
 * hundred per cent gain (#1392). The three figures a reader needs are different
 * questions and are answered separately here: how much the portfolio is worth
 * now against then (`valueChange`), how much of that the reader moved in or out
 * (`netExternalFlows`), and what is left (`investmentResult`) -- the only one a
 * percentage belongs over.
 *
 * Nothing here re-values anything. The boundaries are two points of the very
 * series the chart draws (`NetWorthService.getDailyInvestments`, which resolves
 * the scope through `resolveInvestmentScopeAccountIds` as every other investment
 * surface does), and the flow is classified by the shared predicate in
 * `external-flow.util.ts` and converted through the one date-aware rate door.
 * A second valuation would be a second answer to "what was this worth", which is
 * the disagreement these endpoints exist to prevent.
 *
 * Whether a figure may be reported at all is decided once, in
 * `decidePeriodResult`; `docs/specs/portfolio-period-result.md` is the measure.
 */
@Injectable()
export class PortfolioPeriodResultService {
  private readonly logger = new Logger(PortfolioPeriodResultService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly netWorth: NetWorthService,
  ) {}

  /**
   * The period's result for one scope and window.
   *
   * `baselineDate` is the close the period is measured from where that is NOT
   * the first day of the window: the 1d / 1w / mtd ranges report against the
   * previous trading day's close, and the client sends that date rather than
   * doing the arithmetic on the numbers. The lower bound for flows is exclusive
   * of it -- the baseline's own close already contains every flow that landed
   * that day, and counting those again would subtract them from a starting value
   * that holds them.
   */
  async getPeriodResult(
    userId: string,
    opts: {
      startDate: string;
      endDate?: string;
      baselineDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
    },
  ): Promise<PortfolioPeriodResult> {
    const currency = await this.reportingCurrency(userId, opts.displayCurrency);
    const end = opts.endDate || todayYMD();
    // The baseline is the earlier of the two when both are given, so a client
    // that sends a prior close cannot narrow the window it asked to chart.
    const from =
      opts.baselineDate && opts.baselineDate < opts.startDate
        ? opts.baselineDate
        : opts.startDate;

    const empty: PortfolioPeriodResult = {
      currency,
      startDate: from,
      endDate: end,
      startValue: null,
      endValue: null,
      valueChange: null,
      netExternalFlows: null,
      knownFlowSubtotal: 0,
      investmentResult: null,
      returnPercent: null,
      returnMethod: "simple",
      complete: false,
      reasons: ["noValueSeries"],
      missingRatePairs: [],
      unpricedSecurityIds: [],
      unknownCashAccountIds: [],
    };

    if (from > end) return empty;

    const scope = await this.resolveScope(userId, opts.accountIds);
    if (scope.length === 0) return empty;
    // ONE boundary. The flow is drawn around the accounts whose cash the
    // valuation actually walks, on both sides of a transfer: a deposit posted
    // straight to a brokerage row is a flow the series never sees, and
    // subtracting it from a value change that does not hold it is a loss
    // nobody made (`docs/specs/portfolio-period-result.md` section 6).
    const cashScope = scope
      .filter((row) => isValuationCashAccount(row))
      .map((row) => row.id);

    // The same series the chart reads, for the same scope, in the same currency.
    // Its first and last points ARE the period's boundaries: a day is valued
    // from the latest accepted close on or before it, and the price loaders
    // carry one pre-window observation, so the first point does not depend on
    // how wide a window the caller asked for.
    const [series, flowRows, unmeasuredFlows] = await Promise.all([
      this.netWorth.getDailyInvestments(
        userId,
        from,
        end,
        opts.accountIds,
        currency,
      ),
      loadExternalFlowSubtotals(
        (sql, params) =>
          withScopedDb(this.dataSource, (m) => m.query(sql, params)),
        {
          userId,
          // Exclusive: a flow dated on the baseline is already inside MV(b).
          afterDate: from,
          throughDate: end,
          accountIds: cashScope,
          perDay: true,
        },
      ),
      this.countUnmeasuredFlows(userId, from, end, {
        scope: scope.map((row) => row.id),
        cashScope,
      }),
    ]);

    if (series.length === 0) return empty;

    const flow = await this.foldFlows(flowRows, currency, from, end);

    const decision = decidePeriodResult({
      start: series[0],
      end: series[series.length - 1],
      flow,
      unmeasuredFlows,
    });

    return {
      currency,
      startDate: series[0].date,
      endDate: series[series.length - 1].date,
      ...decision,
    };
  }

  /**
   * The period's net external flow in the reporting currency.
   *
   * Each day-currency subtotal is converted at the rate that stood on ITS OWN
   * day -- a deposit made in January is January's money, not today's -- through
   * the one date-aware resolver (`resolveFxRate`, reached here via the bulk
   * `RateIndex` so a year of flows costs one query rather than one per day).
   * `FxAggregate` is what keeps "could not convert" distinguishable from
   * "converted to zero": a subtotal it could not convert makes the whole flow
   * incomplete, which withholds the result rather than shrinking it.
   */
  private async foldFlows(
    rows: Array<{ date: string | null; currency: string; amount: number }>,
    currency: string,
    start: string,
    end: string,
  ): Promise<{ complete: boolean; value: number; missingPairs: string[] }> {
    const currencies = new Set<string>();
    for (const row of rows) {
      if (row.currency !== currency) currencies.add(row.currency);
    }

    const rateIndex = await buildRateIndex(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      currencies,
      currency,
      start,
      end,
    );

    const aggregate = new FxAggregate();
    for (const row of rows) {
      if (row.amount === 0) continue;
      if (row.currency === currency) {
        aggregate.addConverted(row.amount);
        continue;
      }
      // A row with no date cannot be priced at its own date; this loader is
      // asked for per-day subtotals, so that is a shape it does not return.
      if (!row.date) {
        aggregate.addUnknown();
        continue;
      }
      aggregate.add(
        convertAtDate(
          row.amount,
          row.currency,
          currency,
          row.date,
          rateIndex,
          this.logger,
        ),
        row.currency,
        currency,
      );
    }

    return {
      complete: aggregate.isComplete,
      value: aggregate.knownSubtotal,
      missingPairs: aggregate.missingPairs,
    };
  }

  private async reportingCurrency(
    userId: string,
    displayCurrency?: string,
  ): Promise<string> {
    if (displayCurrency) return displayCurrency;
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preferredCurrency(pref);
  }

  /**
   * How many movements in the window the flow classifier cannot count.
   *
   * Two coarse cases, both documented in `external-flow.util.ts` and both able
   * to move the value without the market having moved:
   *
   *  - an investment action settled somewhere the valuation does not walk cash
   *    (an explicit funding account outside the set, a cash leg posted to an
   *    account outside it), or one that moved shares with no cash leg at all
   *    and no linked leg inside the set -- shares arriving from outside;
   *  - a split parent mixing an embedded investment line with ordinary cash,
   *    which the flow sum drops WHOLE, so its ordinary part is in the value
   *    change and in no flow.
   *
   * Counted, not measured: what each is worth is a line-granular rewrite of the
   * classifier, and a count is enough to withhold. `COUNT(*)` comes back as a
   * string from the driver, so it is coerced at this boundary.
   */
  private async countUnmeasuredFlows(
    userId: string,
    afterDate: string,
    throughDate: string,
    sets: { scope: string[]; cashScope: string[] },
  ): Promise<UnmeasuredFlowCounts> {
    const params = [
      userId,
      afterDate,
      throughDate,
      sets.scope,
      sets.cashScope,
    ] as const;

    const [settled, mixed] = await withScopedDb(this.dataSource, async (m) => {
      const settledRows: Array<{ count: string }> = await m.query(
        `SELECT COUNT(*) AS count
           FROM investment_transactions it
          WHERE it.user_id = $1
            AND it.account_id = ANY($4::UUID[])
            AND it.transaction_date > $2
            AND it.transaction_date <= $3
            AND it.status IS DISTINCT FROM 'VOID'
            AND (
              it.funding_account_id IS NOT NULL
              AND NOT (it.funding_account_id = ANY($5::UUID[]))
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
                  SELECT 1 FROM investment_transactions li
                   WHERE li.id = it.linked_transaction_id
                     AND li.account_id = ANY($4::UUID[])
                )
              )
            )`,
        [...params],
      );
      const mixedRows: Array<{ count: string }> = await m.query(
        `SELECT COUNT(*) AS count
           FROM transactions t
          WHERE t.user_id = $1
            AND t.account_id = ANY($5::UUID[])
            AND t.parent_transaction_id IS NULL
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
            )`,
        [...params],
      );
      return [settledRows, mixedRows];
    });

    return {
      externallySettledTrades: Number(settled[0]?.count ?? 0),
      mixedSplitParents: Number(mixed[0]?.count ?? 0),
    };
  }

  /**
   * The accounts in scope, widened to linked pairs exactly as valuation does,
   * carrying the type columns the cash boundary is drawn from.
   */
  private async resolveScope(
    userId: string,
    accountIds?: string[],
  ): Promise<ScopeAccount[]> {
    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));

    if (accountIds && accountIds.length > 0) {
      const ids = await resolveInvestmentScopeAccountIds(
        query,
        userId,
        accountIds,
      );
      if (ids.length === 0) return [];
      return query(
        `SELECT a.id, a.account_type, a.account_sub_type FROM accounts a
          WHERE a.user_id = $1 AND a.id = ANY($2::UUID[])`,
        [userId, ids],
      ) as Promise<ScopeAccount[]>;
    }
    return query(
      `SELECT a.id, a.account_type, a.account_sub_type FROM accounts a
        WHERE a.user_id = $1 AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`,
      [userId],
    ) as Promise<ScopeAccount[]>;
  }
}
