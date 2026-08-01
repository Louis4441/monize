import { Injectable } from "@nestjs/common";
import { todayYMD } from "../common/date-utils";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import {
  GemPriceService,
  PRICE_WINDOW_LEAD_DAYS,
  withLeadDays,
} from "./gem-price.service";
import { GemBacktestResult, runBacktest } from "./gem-backtest.util";

/**
 * Turns the stored signal history into the report's backtest summary.
 *
 * The simulation replays the evaluations the strategy actually produced, so the
 * summary is bounded by how long the strategy has been running -- there is no
 * synthetic history, and a strategy configured last month reports a month.
 * That is the honest answer: re-deriving signals for years the user never ran
 * would report a rule's past, not theirs.
 */
@Injectable()
export class GemBacktestService {
  constructor(private priceService: GemPriceService) {}

  /**
   * Simulate the stored evaluations, or null when there is nothing to simulate.
   *
   * `notional` is the capital the strategy runs, used only to express the
   * configured per-trade commission as a drag on a unitless equity curve.
   */
  async build(params: {
    strategy: GemStrategy;
    /** Stored evaluations in any order; the simulation sorts them. */
    signals: GemStrategySignal[];
    /** The risk-off instrument, for the "beat the safe asset" comparison. */
    safeSecurityId: string | null;
    notional: number | null;
    /**
     * Whether the strategy evaluated anything before the oldest signal here.
     * Answered from the table by the caller, because the signals in hand are
     * bounded to the last `GEM_HISTORY_PERIODS` periods and cannot say.
     */
    hasEarlierSignals: boolean;
    asOf?: string;
  }): Promise<GemBacktestResult | null> {
    const { strategy, signals, safeSecurityId, notional, hasEarlierSignals } =
      params;
    const asOf = params.asOf ?? todayYMD();

    const periods = [...signals]
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .map((signal) => ({
        effectiveFrom: signal.effectiveFrom,
        targetRole: signal.targetRole,
        targetSecurityId: signal.targetSecurityId,
        // Carried through so the simulation can tell its first period apart
        // from the strategy's first allocation. The history is bounded to the
        // last `GEM_HISTORY_PERIODS` periods, so for any older strategy the
        // oldest signal here follows one nobody passed in -- and treating it
        // as an opening purchase charges a commission for a trade that never
        // happened and dates the tax basis to the edge of the visible window.
        previousRole: signal.previousRole,
      }));
    // One signal is enough: its period runs to `asOf`, so a strategy that
    // produced its first signal last month has a full month to simulate.
    if (periods.length === 0) return null;

    const securityIds = [
      ...new Set(
        [
          ...periods.map((period) => period.targetSecurityId),
          safeSecurityId,
        ].filter((id): id is string => !!id),
      ),
    ];
    if (securityIds.length === 0) return null;

    // Daily closes from a lead window before the first period start: the
    // drawdown is measured inside the periods, not only at their boundaries,
    // and a period opening on a weekend or a holiday is priced by the close
    // before it -- which a series starting exactly on the boundary omits, so
    // the first period read as unpriced while its price sat in the database.
    const seriesBySecurity = await this.priceService.loadSeries(
      securityIds,
      withLeadDays(periods[0].effectiveFrom, PRICE_WINDOW_LEAD_DAYS),
      "day",
    );

    return runBacktest({
      periods,
      hasEarlierSignals,
      seriesBySecurity,
      safeSecurityId,
      taxRatePercent: strategy.taxRatePercent,
      commissionAmount: strategy.commissionAmount,
      notional,
      asOf,
    });
  }
}
