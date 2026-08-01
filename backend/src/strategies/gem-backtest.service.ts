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
    asOf?: string;
  }): Promise<GemBacktestResult | null> {
    const { strategy, signals, safeSecurityId, notional } = params;
    const asOf = params.asOf ?? todayYMD();

    const periods = [...signals]
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .map((signal) => ({
        effectiveFrom: signal.effectiveFrom,
        targetRole: signal.targetRole,
        targetSecurityId: signal.targetSecurityId,
      }));
    if (periods.length < 2) return null;

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
      seriesBySecurity,
      safeSecurityId,
      taxRatePercent: strategy.taxRatePercent,
      commissionAmount: strategy.commissionAmount,
      notional,
      asOf,
    });
  }
}
