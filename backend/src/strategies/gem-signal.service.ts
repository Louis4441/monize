import { Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import {
  GemAssetRole,
  GemStrategyAsset,
} from "./entities/gem-strategy-asset.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemPriceService, PricesByRole } from "./gem-price.service";
import {
  addMonthsUtc,
  evaluate,
  momentumSnapshot,
  parseYmd,
  periodFor,
  recentPeriods,
} from "./gem-momentum.util";

/**
 * How many evaluation periods the report keeps. Two years of monthly signals is
 * enough for the history table and the "see full history" view without turning
 * the first read of a strategy into a long backfill.
 */
export const GEM_HISTORY_PERIODS = 24;

/**
 * Extra days of prices loaded before the momentum window starts, so the base
 * close can be found when the window start is not a trading day. Two weeks
 * covers a weekend plus the longest exchange holiday closures.
 */
const PRICE_WINDOW_LEAD_DAYS = 14;

/**
 * Evaluates GEM periods and keeps them in `gem_strategy_signals`.
 *
 * Evaluation is materialized rather than derived on every read: the momentum
 * figures a decision was taken on must survive later price revisions, and the
 * user's "executed" flag needs a stable row to hang on. It runs on read (the
 * report request) instead of only in a scheduled job so a strategy that was
 * just configured -- or one whose prices arrived late -- produces its history
 * immediately; each period is inserted once and re-evaluating an existing period
 * is a no-op.
 */
@Injectable()
export class GemSignalService {
  private readonly logger = new Logger(GemSignalService.name);

  constructor(
    private dataSource: DataSource,
    private priceService: GemPriceService,
  ) {}

  /** Securities bound to roles, as a role -> securityId map (mapped roles only). */
  private securityByRole(
    assets: GemStrategyAsset[],
  ): Map<GemAssetRole, string> {
    const map = new Map<GemAssetRole, string>();
    for (const asset of assets) {
      if (asset.securityId) map.set(asset.role, asset.securityId);
    }
    return map;
  }

  /**
   * Load the price history the evaluation window needs: from one lookback
   * window before the oldest period being evaluated, up to now.
   *
   * The window start is pulled back by `PRICE_WINDOW_LEAD_DAYS`, because the
   * momentum base is the last close *at or before* the window start. Loading
   * from exactly that date leaves nothing to find whenever it falls on a
   * weekend or a market holiday, and the whole period would then evaluate to
   * "no momentum" and be skipped.
   */
  private async loadEvaluationPrices(
    assets: GemStrategyAsset[],
    oldestEvaluatedOn: string,
    lookbackMonths: number,
    manager: EntityManager,
  ): Promise<PricesByRole> {
    const securityByRole = this.securityByRole(assets);
    const securityIds = [...securityByRole.values()];
    if (securityIds.length === 0) return {};

    const windowStart = addMonthsUtc(
      parseYmd(oldestEvaluatedOn),
      -lookbackMonths,
    );
    windowStart.setUTCDate(windowStart.getUTCDate() - PRICE_WINDOW_LEAD_DAYS);
    const from = windowStart.toISOString().slice(0, 10);
    const series = await this.priceService.loadSeries(
      securityIds,
      from,
      "day",
      manager,
    );

    const prices: PricesByRole = {};
    for (const [role, securityId] of securityByRole) {
      prices[role] = series.get(securityId) ?? [];
    }
    return prices;
  }

  /**
   * Evaluate every period on the strategy's calendar that has no stored signal
   * yet, then return the stored history newest-first.
   *
   * A period whose absolute test cannot be run -- no momentum for the US equity
   * leg or the benchmark -- is skipped rather than stored as a guess, so it can
   * be evaluated later once its prices exist.
   */
  async materialize(
    userId: string,
    strategy: GemStrategy,
    assets: GemStrategyAsset[],
    asOf: string = todayYMD(),
  ): Promise<GemStrategySignal[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(GemStrategySignal);
      const stored = await repo.find({
        where: { strategyId: strategy.id },
        order: { evaluatedOn: "DESC" },
        take: GEM_HISTORY_PERIODS,
      });

      const periods = recentPeriods(
        asOf,
        strategy.cadence,
        GEM_HISTORY_PERIODS,
      );
      const known = new Set(stored.map((signal) => signal.evaluatedOn));
      const missing = periods.filter(
        (period) => !known.has(period.evaluatedOn),
      );
      if (missing.length === 0 || assets.every((a) => !a.securityId)) {
        return stored;
      }

      const prices = await this.loadEvaluationPrices(
        assets,
        missing[0].evaluatedOn,
        strategy.lookbackMonths,
        manager,
      );
      const eligibleRoles = [...this.securityByRole(assets).keys()];
      const securityByRole = this.securityByRole(assets);

      // Chronological order matters: each period's "previous role" is the target
      // of the newest evaluation before it, including ones inserted in this loop.
      const byEvaluatedOn = new Map(
        stored.map((signal) => [signal.evaluatedOn, signal]),
      );
      const inserted: GemStrategySignal[] = [];

      for (const period of periods) {
        if (known.has(period.evaluatedOn)) continue;

        const momentum = momentumSnapshot(
          prices,
          period.evaluatedOn,
          strategy.lookbackMonths,
        );
        const outcome = evaluate(momentum, eligibleRoles);
        if (!outcome) continue;

        const previous = [...byEvaluatedOn.values()]
          .filter((signal) => signal.evaluatedOn < period.evaluatedOn)
          .sort((a, b) => b.evaluatedOn.localeCompare(a.evaluatedOn))[0];

        const signal = repo.create({
          userId,
          strategyId: strategy.id,
          evaluatedOn: period.evaluatedOn,
          effectiveFrom: period.effectiveFrom,
          state: outcome.state,
          targetRole: outcome.targetRole,
          targetSecurityId: outcome.targetRole
            ? (securityByRole.get(outcome.targetRole) ?? null)
            : null,
          targetWeightPercent: 100,
          momentum,
          benchmarkRole: outcome.benchmarkRole,
          spreadPp: outcome.spreadPp,
          leadPp: outcome.leadPp,
          previousRole: previous?.targetRole ?? null,
          executed: false,
        });

        // A concurrent report request may be materializing the same period.
        // The unique index is the arbiter and the row it already inserted is
        // just as good -- but catching the violation is not an option here:
        // this runs inside a transaction, which Postgres aborts on the error,
        // so every later statement in the loop would fail with 25P02 and the
        // request would 500. Let the insert skip instead of raising.
        const result = await repo
          .createQueryBuilder()
          .insert()
          .values(signal)
          .orIgnore()
          .returning("*")
          .execute();
        const saved = (result.generatedMaps[0] ??
          null) as GemStrategySignal | null;
        if (saved) {
          byEvaluatedOn.set(period.evaluatedOn, {
            ...signal,
            ...saved,
          } as GemStrategySignal);
          inserted.push(saved);
        } else {
          this.logger.debug(
            `GEM period ${period.evaluatedOn} was materialized concurrently`,
          );
        }
      }

      if (inserted.length === 0) return stored;

      return repo.find({
        where: { strategyId: strategy.id },
        order: { evaluatedOn: "DESC" },
        take: GEM_HISTORY_PERIODS,
      });
    });
  }

  /** The signal governing the period `asOf` falls in, or null when unevaluated. */
  currentSignal(
    signals: GemStrategySignal[],
    strategy: GemStrategy,
    asOf: string = todayYMD(),
  ): GemStrategySignal | null {
    const period = periodFor(asOf, strategy.cadence);
    return (
      signals.find((signal) => signal.evaluatedOn === period.evaluatedOn) ??
      null
    );
  }

  /** Mark a signal's operation as carried out. Returns false when unknown. */
  async markExecuted(userId: string, signalId: string): Promise<boolean> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(GemStrategySignal);
      const signal = await repo.findOne({ where: { id: signalId, userId } });
      if (!signal) return false;
      if (signal.executed) return true;
      signal.executed = true;
      signal.executedAt = new Date();
      await repo.save(signal);
      return true;
    });
  }
}
