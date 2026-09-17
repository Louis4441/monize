import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import { FxAggregate } from "../common/fx-aggregate";
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
import { NetWorthService } from "./net-worth.service";
import {
  PeriodResultReason,
  PeriodReturnMethod,
  decidePeriodResult,
} from "./portfolio-period-result.util";

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

    // The same series the chart reads, for the same scope, in the same currency.
    // Its first and last points ARE the period's boundaries: a day is valued
    // from the latest accepted close on or before it, and the price loaders
    // carry one pre-window observation, so the first point does not depend on
    // how wide a window the caller asked for.
    const [series, flowRows] = await Promise.all([
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
          accountIds: scope,
          perDay: true,
        },
      ),
    ]);

    if (series.length === 0) return empty;

    const flow = await this.foldFlows(flowRows, currency, from, end);

    const decision = decidePeriodResult({
      start: series[0],
      end: series[series.length - 1],
      flow,
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

  /** The accounts in scope, widened to linked pairs exactly as valuation does. */
  private async resolveScope(
    userId: string,
    accountIds?: string[],
  ): Promise<string[]> {
    if (accountIds && accountIds.length > 0) {
      return resolveInvestmentScopeAccountIds(
        (sql, params) =>
          withScopedDb(this.dataSource, (m) => m.query(sql, params)),
        userId,
        accountIds,
      );
    }
    const rows: Array<{ id: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT a.id FROM accounts a
            WHERE a.user_id = $1 AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`,
          [userId],
        ),
    );
    return rows.map((row) => row.id);
  }
}
