import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import { loadExternalFlowSubtotals } from "../securities/external-flow.util";
import {
  UNFILTERED_INVESTMENT_SCOPE_SQL,
  resolveInvestmentScopeAccountIds,
} from "../securities/investment-scope.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NetWorthService, isValuationCashAccount } from "./net-worth.service";
import { SeriesFetchOptions, computeWithRateFill } from "./series-rate-fill";
import {
  FlowSubtotalRow,
  FoldedFlow,
  buildFlowRateIndex,
  foldFlowSubtotals,
} from "./period-flow-fold.util";
import {
  PeriodResultReason,
  PeriodReturnMethod,
  UnmeasuredFlowCounts,
  decidePeriodResult,
} from "./portfolio-period-result.util";
import {
  loadUnmeasuredFlowRows,
  unmeasuredFlowsAfter,
} from "./unmeasured-flows.util";

/** One account of the scope, with what the cash boundary is decided from. */
export interface ScopeAccount {
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
    // The read-path FX fill for the flow fold; the value series fills through
    // NetWorthService. Optional + forwardRef for the same reasons it is there:
    // CurrenciesModule reaches back here through SecuritiesModule, and a
    // harness without it reports the pair missing exactly as before.
    @Optional()
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRates?: ExchangeRateService,
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
    } & SeriesFetchOptions,
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
        // One opt-out for the whole answer: the value series and the flow fold
        // read the same rates and must not disagree about whether to fetch.
        { fetchMissing: opts.fetchMissing },
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

    const flow = await this.foldFlows(flowRows, currency, from, end, {
      fetchMissing: opts.fetchMissing,
    });

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
   * The period's net external flow in the reporting currency, through the one
   * fold every period route shares (`period-flow-fold.util.ts`): each day's
   * subtotal converted at that day's own rate, and a subtotal that would not
   * convert making the whole flow incomplete rather than smaller.
   *
   * A day whose flow could not be converted is also a gap the provider may be
   * able to close, so the fold runs through `computeWithRateFill`: it names the
   * months and pairs it was short of, the provider is asked once per unit, and
   * on a successful fill the index is re-read from the database and the fold
   * re-run. Nothing is invented -- what the provider does not carry stays in
   * `missingPairs` and still withholds the result.
   */
  private foldFlows(
    rows: FlowSubtotalRow[],
    currency: string,
    start: string,
    end: string,
    options?: SeriesFetchOptions,
  ): Promise<FoldedFlow> {
    return computeWithRateFill(
      this.exchangeRates,
      () => this.foldFlowsAt(rows, currency, start, end),
      (folded) => folded.gaps,
      options,
      this.logger,
    );
  }

  /** One pass of `foldFlows` over one rate index, freshly loaded. */
  private async foldFlowsAt(
    rows: FlowSubtotalRow[],
    currency: string,
    start: string,
    end: string,
  ): Promise<FoldedFlow> {
    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));
    const rateIndex = await buildFlowRateIndex(
      query,
      rows,
      currency,
      start,
      end,
    );
    return foldFlowSubtotals(rows, currency, rateIndex, this.logger);
  }

  /** Public because the batch route reports in the very same currency. */
  async reportingCurrency(
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
   * The two coarse cases and their predicates are `unmeasured-flows.util.ts`,
   * shared with the batch route so the two cannot disagree about whether a
   * period is measurable. Counted, not measured: what each is worth is a
   * line-granular rewrite of the classifier, and a count is enough to withhold.
   */
  private async countUnmeasuredFlows(
    userId: string,
    afterDate: string,
    throughDate: string,
    sets: { scope: string[]; cashScope: string[] },
  ): Promise<UnmeasuredFlowCounts> {
    const rows = await loadUnmeasuredFlowRows(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      {
        userId,
        afterDate,
        throughDate,
        scope: sets.scope,
        cashScope: sets.cashScope,
      },
    );
    return unmeasuredFlowsAfter(rows);
  }

  /**
   * The accounts in scope, widened to linked pairs exactly as valuation does,
   * carrying the type columns the cash boundary is drawn from. Public for the
   * same reason as `reportingCurrency`: one scope, resolved once, for every
   * route that reports over it.
   */
  async resolveScope(
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
