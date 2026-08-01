import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import {
  GEM_ASSET_ROLES,
  GemAssetRole,
  GemStrategyAsset,
} from "./entities/gem-strategy-asset.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemPriceService, PricesByRole } from "./gem-price.service";
import {
  addMonthsUtc,
  benchmarkRoleFor,
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

/** The date a period's momentum window opens: one lookback before evaluation. */
function windowStartFor(evaluatedOn: string, lookbackMonths: number): string {
  return addMonthsUtc(parseYmd(evaluatedOn), -lookbackMonths)
    .toISOString()
    .slice(0, 10);
}

/**
 * A hash of everything about a strategy that decides what its signals say.
 *
 * A stored signal used to be treated as permanently done, but the inputs behind
 * it are editable: shorten the lookback, switch to quarterly, or swap the fund
 * in a role and the same row now answers a question nobody asked. Stamping each
 * signal with this and comparing on read is what makes "the configuration
 * changed" visible to a table keyed only by (strategy, period).
 *
 * Every role is included, assigned or not: an empty role changes which markets
 * compete in the ranking, and clearing the risk-free leg moves the absolute
 * test onto the safe asset. What is deliberately *not* here is anything that
 * only affects presentation or cost estimates -- the tax rate, the commission,
 * the scenario's name, the accounts -- because rewriting the whole evaluation
 * history when someone corrects a commission would be worse than useless.
 */
export function gemConfigFingerprint(
  strategy: Pick<GemStrategy, "cadence" | "lookbackMonths">,
  assets: GemStrategyAsset[],
): string {
  const roles = [...GEM_ASSET_ROLES]
    .sort()
    .map((role) => {
      const asset = assets.find((candidate) => candidate.role === role);
      return `${role}=${asset?.securityId ?? "-"}`;
    })
    .join(",");
  const material = `${strategy.cadence}|${strategy.lookbackMonths}|${roles}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 64);
}

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
   * The first period the price history can possibly answer for, or null when it
   * cannot answer for any.
   *
   * The absolute test needs a base close at or before the momentum window's
   * start for both the US equity leg and the benchmark, so a period whose
   * window opens before either instrument's first recorded close can never
   * evaluate. Left unchecked those periods are retried on every single report
   * load -- a strategy configured with two years of history but instruments
   * listed last year re-reads the whole price window each time to conclude the
   * same nothing. One cheap aggregate per load replaces that.
   *
   * This is a bound, not a watermark: nothing is remembered, so the moment a
   * backfill pushes an instrument's history further back the periods it unlocks
   * are evaluated on the next load with no state to reset.
   */
  private async earliestEvaluableWindowStart(
    assets: GemStrategyAsset[],
    manager: EntityManager,
  ): Promise<string | null> {
    const securityByRole = this.securityByRole(assets);
    const required = [
      "US_EQUITY" as GemAssetRole,
      benchmarkRoleFor([...securityByRole.keys()]),
    ];
    const securityIds = required.map((role) => securityByRole.get(role));
    // A required leg with no instrument at all: nothing can be evaluated.
    if (securityIds.some((id) => !id)) return null;

    const earliest = await this.priceService.earliestPriceDates(
      securityIds as string[],
      manager,
    );
    if (earliest.size < new Set(securityIds).size) return null;
    // Both legs must reach back that far, so the later first close governs.
    return [...earliest.values()].sort().pop() ?? null;
  }

  /**
   * Evaluate every period on the strategy's calendar that has no stored signal
   * yet, then return the stored history newest-first.
   *
   * A period whose absolute test cannot be run -- no momentum for the US equity
   * leg or the benchmark -- is skipped rather than stored as a guess, so it can
   * be evaluated later once its prices exist.
   *
   * Materializing on a read is deliberate (see the class comment) and writes
   * nothing the caller supplies: every column is derived from the user's own
   * stored prices, and the unique index makes a repeat a no-op. That is why it
   * is not marked `@DemoRestricted()` -- there is no request body to abuse, and
   * a demo account materializing its own signals is what makes the demo's
   * report show anything at all.
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
      // A period counts as answered only when its row was calculated under the
      // configuration in force now. Shorten the lookback or swap an instrument
      // and the stored answer is to a different question, so it is recomputed
      // in place rather than served as the current instruction.
      const fingerprint = gemConfigFingerprint(strategy, assets);
      const staleByPeriod = new Map(
        stored
          .filter((signal) => signal.configFingerprint !== fingerprint)
          .map((signal) => [signal.evaluatedOn, signal]),
      );
      const answered = new Set(
        stored
          .filter((signal) => signal.configFingerprint === fingerprint)
          .map((signal) => signal.evaluatedOn),
      );
      const unstored = periods.filter(
        (period) => !answered.has(period.evaluatedOn),
      );
      if (unstored.length === 0 || assets.every((a) => !a.securityId)) {
        return stored;
      }

      // Drop the periods whose momentum window opens before the price history
      // does. They would evaluate to nothing, and re-reading a year of prices
      // to establish that on every report load is the whole cost of a strategy
      // whose instruments are younger than its history window.
      const earliestWindowStart = await this.earliestEvaluableWindowStart(
        assets,
        manager,
      );
      if (earliestWindowStart === null) return stored;
      const missing = unstored.filter(
        (period) =>
          windowStartFor(period.evaluatedOn, strategy.lookbackMonths) >=
          earliestWindowStart,
      );
      if (missing.length === 0) return stored;

      const prices = await this.loadEvaluationPrices(
        assets,
        missing[0].evaluatedOn,
        strategy.lookbackMonths,
        manager,
      );
      const evaluable = new Set(missing.map((period) => period.evaluatedOn));
      const eligibleRoles = [...this.securityByRole(assets).keys()];
      const securityByRole = this.securityByRole(assets);

      // Chronological order matters: each period's "previous role" is the target
      // of the newest evaluation before it, including ones inserted in this loop.
      const byEvaluatedOn = new Map(
        stored.map((signal) => [signal.evaluatedOn, signal]),
      );
      const written: GemStrategySignal[] = [];

      for (const period of periods) {
        if (answered.has(period.evaluatedOn)) continue;
        if (!evaluable.has(period.evaluatedOn)) continue;

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

        const targetSecurityId = outcome.targetRole
          ? (securityByRole.get(outcome.targetRole) ?? null)
          : null;
        const signal = repo.create({
          userId,
          strategyId: strategy.id,
          evaluatedOn: period.evaluatedOn,
          effectiveFrom: period.effectiveFrom,
          state: outcome.state,
          targetRole: outcome.targetRole,
          targetSecurityId,
          targetWeightPercent: 100,
          momentum,
          benchmarkRole: outcome.benchmarkRole,
          spreadPp: outcome.spreadPp,
          leadPp: outcome.leadPp,
          previousRole: previous?.targetRole ?? null,
          configFingerprint: fingerprint,
          executed: false,
        });

        // A period already stored under an older configuration is replaced in
        // place: the unique index owns (strategy, period), and a second row for
        // the same month would be a second answer to one question.
        const outdated = staleByPeriod.get(period.evaluatedOn);
        if (outdated) {
          // "I have carried this out" describes an instruction. It survives a
          // recomputation that lands on the same instrument -- the user did
          // that trade -- and is cleared when the instruction changes, because
          // nobody executed the new one.
          const sameInstruction =
            outdated.targetSecurityId === targetSecurityId &&
            outdated.targetRole === outcome.targetRole;
          const refreshed = {
            ...outdated,
            ...signal,
            id: outdated.id,
            executed: sameInstruction ? outdated.executed : false,
            executedAt: sameInstruction ? outdated.executedAt : null,
          } as GemStrategySignal;
          await repo.save(refreshed);
          byEvaluatedOn.set(period.evaluatedOn, refreshed);
          written.push(refreshed);
          continue;
        }

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
          written.push(saved);
        } else {
          this.logger.debug(
            `GEM period ${period.evaluatedOn} was materialized concurrently`,
          );
        }
      }

      if (written.length === 0) return stored;

      return repo.find({
        where: { strategyId: strategy.id },
        order: { evaluatedOn: "DESC" },
        take: GEM_HISTORY_PERIODS,
      });
    });
  }

  /**
   * The signal governing the period `asOf` falls in, or null when there is
   * none the strategy's current configuration would produce.
   *
   * `materialize` refreshes a period it can recompute, so a row still carrying
   * a foreign fingerprint here is one the price history cannot reach under the
   * new settings -- a lookback stretched past the instrument's first close, for
   * instance. Serving it would present a decision taken under rules that no
   * longer exist as the instruction to act on now, which is precisely the thing
   * the fingerprint exists to stop. It stays in the history, where it is a
   * true record of what was decided then.
   */
  currentSignal(
    signals: GemStrategySignal[],
    strategy: GemStrategy,
    asOf: string = todayYMD(),
    assets: GemStrategyAsset[] = [],
  ): GemStrategySignal | null {
    const period = periodFor(asOf, strategy.cadence);
    const signal =
      signals.find((entry) => entry.evaluatedOn === period.evaluatedOn) ?? null;
    if (!signal) return null;
    // No assets passed means the caller is not checking provenance (the specs
    // that predate the fingerprint), and the stored row stands.
    if (assets.length === 0) return signal;
    return signal.configFingerprint === gemConfigFingerprint(strategy, assets)
      ? signal
      : null;
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
