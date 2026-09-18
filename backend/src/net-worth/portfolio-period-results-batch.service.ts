import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { loadExternalFlowSubtotals } from "../securities/external-flow.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService, isValuationCashAccount } from "./net-worth.service";
import { SeriesFetchOptions, computeWithRateFill } from "./series-rate-fill";
import {
  FlowSubtotalRow,
  buildFlowRateIndex,
  foldFlowSubtotals,
} from "./period-flow-fold.util";
import {
  PORTFOLIO_PERIOD_PRESETS,
  PortfolioPeriodPreset,
  presetEarliestDate,
  presetWindowStart,
  usesPriorCloseBaseline,
} from "./portfolio-period-presets.util";
import {
  PortfolioPeriodResult,
  PortfolioPeriodResultService,
} from "./portfolio-period-result.service";
import { decidePeriodResult } from "./portfolio-period-result.util";
import {
  loadUnmeasuredFlowRows,
  unmeasuredFlowsAfter,
} from "./unmeasured-flows.util";
import {
  foldInvestedFlows,
  loadInvestedCapitalFlowRows,
} from "./invested-capital-flow.util";
import {
  NO_INVESTED_PERIOD,
  investedPeriodResult,
} from "./invested-period-result.util";

/** What `GET /net-worth/investments-period-results` answers. */
export interface PortfolioPeriodResults {
  /** The currency every figure in every period is in. */
  currency: string;
  /** The day every period is measured TO. */
  asOf: string;
  /** One entry per preset asked for, keyed by the preset. */
  periods: Partial<Record<PortfolioPeriodPreset, PortfolioPeriodResult>>;
}

export interface PortfolioPeriodResultsOptions extends SeriesFetchOptions {
  /** Which windows to answer; every preset when empty or omitted. */
  periods?: readonly PortfolioPeriodPreset[];
  accountIds?: string[];
  displayCurrency?: string;
  /** The day the windows end on; the server's own today when omitted. */
  endDate?: string;
}

/**
 * Six trailing windows of the same portfolio, measured once.
 *
 * Every figure is the one `PortfolioPeriodResultService` would have answered
 * for that window: the same value series, the same flow classifier, the same
 * per-day conversion and the same `decidePeriodResult`. What differs is how
 * often the expensive parts run. `getDailyInvestments` rebuilds a portfolio's
 * whole valuation, and the year's series already contains every shorter
 * window's points, so this service builds it ONCE for the widest window asked
 * for, loads the per-day flow subtotals and the unmeasurable-movement counts
 * once beside it, and derives each preset by slicing:
 *
 *  - the end boundary is the series' last point, shared by every preset;
 *  - the start boundary is the last point on or before the preset's baseline
 *    (1d and 1w report against the previous close) or the first point on or
 *    after the window's start (every other preset);
 *  - the flows and the unmeasurable counts are the days strictly after the
 *    preset's own lower bound, which is exactly what a single-range call with
 *    that bound would have loaded.
 *
 * Slicing rather than recomputing is safe because neither the series nor the
 * rate index depends on how wide a window was asked for: a day is valued from
 * the latest accepted close on or before it, and `buildRateIndex` loads enough
 * rows that a date resolves the same in any window (issue #1390 is the defect
 * that established that). `portfolio-period-results-batch.service.spec.ts`
 * holds the two routes to the same answers on the same fixture, preset by
 * preset -- the "a preview computes what the commit will do" rule, applied to
 * two readers of one measure.
 *
 * A preset whose baseline predates the first point of the series is `null` with
 * `noValueSeries`: a portfolio three days old has no one-year return, and
 * measuring from its first day instead would report a number that looks like
 * one.
 */
@Injectable()
export class PortfolioPeriodResultsBatchService {
  private readonly logger = new Logger(PortfolioPeriodResultsBatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly netWorth: NetWorthService,
    private readonly periodResult: PortfolioPeriodResultService,
    // The read-path FX fill for the flow fold, optional and forward-referenced
    // for the reasons `PortfolioPeriodResultService` gives; the value series
    // fills through `NetWorthService`.
    @Optional()
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRates?: ExchangeRateService,
  ) {}

  async getPeriodResults(
    userId: string,
    opts: PortfolioPeriodResultsOptions = {},
  ): Promise<PortfolioPeriodResults> {
    const presets =
      opts.periods && opts.periods.length > 0
        ? [...new Set(opts.periods)]
        : [...PORTFOLIO_PERIOD_PRESETS];
    const currency = await this.periodResult.reportingCurrency(
      userId,
      opts.displayCurrency,
    );
    const end = opts.endDate || todayYMD();

    // The widest window any preset can need a value for. A prior-close preset
    // reaches one day further back than its window opens, because that close is
    // what it is measured from.
    const earliest = presets
      .map((preset) => presetEarliestDate(preset, end))
      .reduce((a, b) => (a < b ? a : b));

    // The empty answer is the decision itself over no boundaries, so the shape
    // and the reason are the same ones every other caller of the policy gets.
    const empty = (startDate: string): PortfolioPeriodResult => ({
      currency,
      startDate,
      endDate: end,
      ...decidePeriodResult({
        start: null,
        end: null,
        flow: { complete: true, value: 0, missingPairs: [] },
      }),
      ...NO_INVESTED_PERIOD,
    });

    const allEmpty = (): PortfolioPeriodResults => ({
      currency,
      asOf: end,
      periods: Object.fromEntries(
        presets.map((preset) => [
          preset,
          empty(presetWindowStart(preset, end)),
        ]),
      ),
    });

    if (earliest > end) return allEmpty();

    const scope = await this.periodResult.resolveScope(userId, opts.accountIds);
    if (scope.length === 0) return allEmpty();
    // ONE boundary, the same one the single-range route draws: the accounts
    // whose ledger cash the valuation actually walks, on both sides of a
    // transfer.
    const cashScope = scope
      .filter((row) => isValuationCashAccount(row))
      .map((row) => row.id);
    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));

    const [series, flowRows, investedRows, unmeasuredRows] = await Promise.all([
      this.netWorth.getDailyInvestments(
        userId,
        earliest,
        end,
        opts.accountIds,
        currency,
        // One opt-out for the whole answer, as in the single-range route.
        { fetchMissing: opts.fetchMissing },
      ),
      loadExternalFlowSubtotals(query, {
        userId,
        // Exclusive, as in the single-range route: a flow dated on a preset's
        // baseline is already inside that preset's MV(b), and the per-preset
        // slice below keeps that exclusivity for every later baseline too.
        afterDate: earliest,
        throughDate: end,
        accountIds: cashScope,
        perDay: true,
      }) as Promise<FlowSubtotalRow[]>,
      // The invested part's capital and income over the same widest window,
      // loaded ONCE beside the flows and sliced per preset exactly as they are.
      loadInvestedCapitalFlowRows(query, {
        userId,
        afterDate: earliest,
        throughDate: end,
        accountIds: scope.map((row) => row.id),
      }),
      loadUnmeasuredFlowRows(query, {
        userId,
        afterDate: earliest,
        throughDate: end,
        scope: scope.map((row) => row.id),
        cashScope,
        perDay: true,
      }),
    ]);

    if (series.length === 0) return allEmpty();

    // ONE index for the widest window, filled once: the fold over every row
    // names the months and pairs it is short of, the provider is asked once per
    // unit, and on a successful fill the index is re-read from the database.
    // Each preset's slice below folds against that same index, so a preset
    // cannot see a rate the whole window did not.
    const { rateIndex, investedByDay } = await computeWithRateFill(
      this.exchangeRates,
      async () => {
        const index = await buildFlowRateIndex(
          query,
          [...flowRows, ...investedRows],
          currency,
          earliest,
          end,
        );
        // Folded per DAY once, for the whole window: a day is the same day
        // whatever preset reads it, which is what makes a preset's slice
        // identical to what the single-range route would have folded for it.
        const invested = foldInvestedFlows(
          investedRows,
          currency,
          index,
          this.logger,
        );
        return {
          rateIndex: index,
          investedByDay: invested.byDay,
          gaps: [
            ...foldFlowSubtotals(flowRows, currency, index, this.logger).gaps,
            ...invested.gaps,
          ],
        };
      },
      (built) => built.gaps,
      { fetchMissing: opts.fetchMissing },
      this.logger,
    );

    const last = series[series.length - 1];
    const periods: Partial<
      Record<PortfolioPeriodPreset, PortfolioPeriodResult>
    > = {};
    for (const preset of presets) {
      const windowStart = presetWindowStart(preset, end);
      const start = this.startBoundary(series, preset, windowStart);
      if (!start) {
        periods[preset] = empty(windowStart);
        continue;
      }
      // The lower bound the single-range route would have been given for this
      // preset: its baseline where it has one, its window start otherwise.
      const from = usesPriorCloseBaseline(preset) ? start.date : windowStart;
      // A row with no date is kept: the fold reports it as unknown, which
      // withholds the flow rather than quietly dropping money out of it.
      const flow = foldFlowSubtotals(
        flowRows.filter((row) => row.date === null || row.date > from),
        currency,
        rateIndex,
        this.logger,
      );
      const unmeasuredFlows = unmeasuredFlowsAfter(unmeasuredRows, from);
      periods[preset] = {
        currency,
        startDate: start.date,
        endDate: last.date,
        ...decidePeriodResult({ start, end: last, flow, unmeasuredFlows }),
        // The same one series, sliced at this preset's own boundary: the TWR
        // for a preset is a product over that preset's days, O(days), over the
        // per-day flows folded once above.
        ...investedPeriodResult({
          points: series,
          startIndex: series.indexOf(start),
          endIndex: series.length - 1,
          flowsByDay: investedByDay,
          unmeasuredFlows,
        }),
      };
    }

    return { currency, asOf: end, periods };
  }

  /**
   * Where the preset is measured FROM, as a point of the series.
   *
   * A prior-close preset takes the last point on or before the day before its
   * window's first point: the close the session opened against. Every other
   * preset takes the first point inside its window, which already IS the close
   * of the day the window opens on. `null` when the series does not reach back
   * that far, which is a period this scope cannot report rather than one that
   * did nothing.
   */
  private startBoundary<T extends { date: string }>(
    series: readonly T[],
    preset: PortfolioPeriodPreset,
    windowStart: string,
  ): T | null {
    const firstInWindow = series.find((point) => point.date >= windowStart);
    if (!firstInWindow) return null;
    if (!usesPriorCloseBaseline(preset)) {
      // A window the series does not reach back to is a period this scope
      // cannot report. Measuring from the first day it held anything instead
      // would put a figure under a caption promising a whole year of it -- the
      // "n/a rather than 0%" rule the security card already keeps.
      return series[0].date <= windowStart ? firstInWindow : null;
    }

    const baseline = addDaysYMD(firstInWindow.date, -1);
    let prior: T | null = null;
    for (const point of series) {
      if (point.date > baseline) break;
      prior = point;
    }
    return prior;
  }
}
