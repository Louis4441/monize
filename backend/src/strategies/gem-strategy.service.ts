import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { tr } from "../i18n/translate";
import { Account } from "../accounts/entities/account.entity";
import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  GEM_ASSET_ROLES,
  GEM_EQUITY_ROLES,
  GEM_OPTIONAL_ROLES,
  GemAssetRole,
  GemStrategyAsset,
} from "./entities/gem-strategy-asset.entity";
import { GemStrategyAccount } from "./entities/gem-strategy-account.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { UpdateGemStrategyDto } from "./dto/update-gem-strategy.dto";
import {
  addMonthsUtc,
  cadenceMonths,
  historyAction,
  parseYmd,
  periodFor,
  rankEquities,
} from "./gem-momentum.util";
import { GemBackfillService } from "./gem-backfill.service";
import { GemBacktestService } from "./gem-backtest.service";
import { GemPerformanceService } from "./gem-performance.service";
import { GemPositionService } from "./gem-position.service";
import { GemPriceService } from "./gem-price.service";
import { GemSignalService } from "./gem-signal.service";
import {
  GemAccountRef,
  GemAssetMomentum,
  GemAssetRef,
  GemHistoryEntryView,
  GemRange,
  GemSignalView,
  GemStrategyMetaView,
  GemStrategyRef,
  GemStrategyReportView,
  GemWarning,
} from "./gem-report.types";

/** Prices older than this make the signal provisional. */
const STALE_PRICE_DAYS = 5;

const DEFAULT_CURRENCY = "CAD";

/** Lookback the unconfigured report reports, matching the column default. */
const DEFAULT_LOOKBACK_MONTHS = 12;

/** Name a scenario gets when its creator did not supply one. */
const DEFAULT_STRATEGY_NAME = "GEM";

/**
 * The GEM strategy read model: one call assembles the whole report page --
 * current signal, why it says what it says, how the real portfolio compares, and
 * the single operation to carry out.
 *
 * Every figure comes from either stored evaluations (`gem_strategy_signals`) or
 * prices; nothing is recomputed on the client. The strategy rules themselves
 * live in `gem-momentum.util`, the position arithmetic in `gem-position.util`.
 */
@Injectable()
export class GemStrategyService {
  constructor(
    private dataSource: DataSource,
    private signalService: GemSignalService,
    private positionService: GemPositionService,
    private performanceService: GemPerformanceService,
    private priceService: GemPriceService,
    private backfillService: GemBackfillService,
    private backtestService: GemBacktestService,
  ) {}

  /**
   * Config, role assignments and the accounts the strategy is run in, or null
   * when the user has no GEM strategy yet.
   */
  private async loadStrategy(
    userId: string,
    strategyId?: string,
  ): Promise<{
    strategy: GemStrategy;
    assets: GemStrategyAsset[];
    accounts: GemAccountRef[];
  } | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      // A named scenario, or the oldest one -- which is the only one for a user
      // who never created a second, so the default report is unchanged.
      const strategy = await manager.getRepository(GemStrategy).findOne({
        where: strategyId ? { id: strategyId, userId } : { userId },
        order: { createdAt: "ASC" },
      });
      if (!strategy) return null;
      const assets = await manager.getRepository(GemStrategyAsset).find({
        where: { strategyId: strategy.id },
        relations: ["security"],
      });
      const links = await manager.getRepository(GemStrategyAccount).find({
        where: { strategyId: strategy.id },
        relations: ["account"],
      });
      const accounts = links
        .filter((link) => link.account)
        .map((link) => ({ id: link.account.id, name: link.account.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { strategy, assets, accounts };
    });
  }

  /** Every saved scenario, oldest first, for the report's switcher. */
  async listStrategies(userId: string): Promise<GemStrategyRef[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = await manager.getRepository(GemStrategy).find({
        where: { userId },
        order: { createdAt: "ASC" },
        select: { id: true, name: true },
      });
      return rows.map((row) => ({ id: row.id, name: row.name }));
    });
  }

  private async defaultCurrency(userId: string): Promise<string> {
    const preference = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preference?.defaultCurrency || DEFAULT_CURRENCY;
  }

  /** Every role, mapped or not, so the client can name what is missing. */
  private buildAssetRefs(
    assets: GemStrategyAsset[],
  ): Map<GemAssetRole, GemAssetRef> {
    const byRole = new Map(assets.map((asset) => [asset.role, asset]));
    const refs = new Map<GemAssetRole, GemAssetRef>();
    for (const role of GEM_ASSET_ROLES) {
      const asset = byRole.get(role);
      refs.set(role, {
        role,
        securityId: asset?.securityId ?? null,
        symbol: asset?.security?.symbol ?? null,
        name: asset?.security?.name ?? null,
      });
    }
    return refs;
  }

  private momentumOf(
    refs: Map<GemAssetRole, GemAssetRef>,
    role: GemAssetRole,
    momentum: Partial<Record<GemAssetRole, number | null>>,
    rank: number | null,
  ): GemAssetMomentum {
    return {
      ...(refs.get(role) as GemAssetRef),
      momentum12m: momentum[role] ?? null,
      rank,
    };
  }

  /** Expand a stored signal into the two decision steps the report explains. */
  private toSignalView(
    signal: GemStrategySignal,
    refs: Map<GemAssetRole, GemAssetRef>,
  ): GemSignalView {
    const mappedEquities = GEM_EQUITY_ROLES.filter(
      (role) => refs.get(role)?.securityId,
    );
    const ranked = rankEquities(signal.momentum, mappedEquities);
    const rankByRole = new Map(
      ranked.map((entry, index) => [entry.role, index + 1]),
    );

    return {
      id: signal.id,
      state: signal.state,
      target: signal.targetRole ? (refs.get(signal.targetRole) ?? null) : null,
      targetWeightPercent: Number(signal.targetWeightPercent),
      effectiveFrom: signal.effectiveFrom,
      evaluatedOn: signal.evaluatedOn,
      absolute: {
        equity: this.momentumOf(
          refs,
          "US_EQUITY",
          signal.momentum,
          rankByRole.get("US_EQUITY") ?? null,
        ),
        // Pre-split evaluations carry no benchmark role; they were all taken
        // against the safe asset, which is what NULL reads as.
        benchmark: this.momentumOf(
          refs,
          signal.benchmarkRole ?? "SAFE",
          signal.momentum,
          null,
        ),
        spreadPp: signal.spreadPp,
        result: signal.state,
      },
      relative: {
        ranking: ranked.map((entry, index) =>
          this.momentumOf(refs, entry.role, signal.momentum, index + 1),
        ),
        winner: ranked[0] ? (refs.get(ranked[0].role) ?? null) : null,
        leadPp: signal.leadPp,
        // While RISK-OFF the ranking is computed but does not drive allocation.
        applied: signal.state === "RISK_ON",
      },
    };
  }

  private toHistoryEntry(
    signal: GemStrategySignal,
    refs: Map<GemAssetRole, GemAssetRef>,
  ): GemHistoryEntryView {
    const action = historyAction(signal.targetRole, signal.previousRole);
    return {
      id: signal.id,
      evaluatedOn: signal.evaluatedOn,
      effectiveFrom: signal.effectiveFrom,
      winner: signal.targetRole ? (refs.get(signal.targetRole) ?? null) : null,
      state: signal.state,
      action,
      momentum: signal.momentum,
      change:
        action === "SWITCH"
          ? {
              from: signal.previousRole
                ? (refs.get(signal.previousRole) ?? null)
                : null,
              to: signal.targetRole
                ? (refs.get(signal.targetRole) ?? null)
                : null,
            }
          : null,
      // A HOLD asked for nothing, so "executed" does not apply to it.
      executed: action === "HOLD" ? null : signal.executed,
    };
  }

  /**
   * When the next evaluation falls: the price date the following period will be
   * decided on, i.e. the last day before it starts.
   */
  private nextEvaluation(
    strategy: GemStrategy,
    asOf: string,
  ): { on: string; days: number } {
    const current = periodFor(asOf, strategy.cadence);
    const nextStart = addMonthsUtc(
      parseYmd(current.effectiveFrom),
      cadenceMonths(strategy.cadence),
    );
    const evaluatedOn = new Date(nextStart);
    evaluatedOn.setUTCDate(0);
    const days = Math.max(
      0,
      Math.round(
        (evaluatedOn.getTime() - parseYmd(asOf).getTime()) / 86_400_000,
      ),
    );
    return { on: evaluatedOn.toISOString().slice(0, 10), days };
  }

  /** The report a user with no configured strategy gets: shape, no invented data. */
  private emptyReport(
    refs: Map<GemAssetRole, GemAssetRef>,
    name: string,
  ): GemStrategyReportView {
    const meta: GemStrategyMetaView = {
      id: null,
      name,
      cadence: "MONTHLY",
      lookbackMonths: DEFAULT_LOOKBACK_MONTHS,
      taxRatePercent: null,
      commissionAmount: null,
      nextEvaluationOn: null,
      daysUntilNextEvaluation: null,
      pricesAsOf: null,
      rulesSourceUrl: null,
      rulesSourceLabel: null,
      accounts: [],
    };
    return {
      strategy: meta,
      strategies: [],
      assets: [...refs.values()],
      signal: null,
      position: null,
      action: null,
      performance: null,
      history: [],
      backtest: null,
      warnings: [
        { code: "FIRST_RUN" },
        {
          code: "UNMAPPED_ROLE",
          roles: GEM_ASSET_ROLES.filter(
            (role) => !GEM_OPTIONAL_ROLES.includes(role),
          ),
        },
        { code: "NO_ACCOUNT" },
      ],
    };
  }

  async getReport(
    userId: string,
    range: GemRange = "1Y",
    strategyId?: string,
  ): Promise<GemStrategyReportView> {
    const asOf = todayYMD();
    const loaded = await this.loadStrategy(userId, strategyId);
    if (!loaded) {
      return this.emptyReport(
        this.buildAssetRefs([]),
        tr("strategies.gem.defaultName", DEFAULT_STRATEGY_NAME),
      );
    }

    const { strategy, assets, accounts } = loaded;
    const refs = this.buildAssetRefs(assets);
    const securityByRole = new Map<GemAssetRole, string>();
    for (const [role, ref] of refs) {
      if (ref.securityId) securityByRole.set(role, ref.securityId);
    }
    // An unassigned optional role is not a gap: the strategy runs without it.
    const unmappedRoles = GEM_ASSET_ROLES.filter(
      (role) => !securityByRole.has(role) && !GEM_OPTIONAL_ROLES.includes(role),
    );

    const signals = await this.signalService.materialize(
      userId,
      strategy,
      assets,
      asOf,
    );
    const current = this.signalService.currentSignal(signals, strategy, asOf);

    // Money is reported in the user's default currency: several accounts can be
    // in the strategy, in different currencies, and the totals have to add up.
    const currencyCode = await this.defaultCurrency(userId);
    const { position, action, noPosition } = await this.positionService.build({
      userId,
      strategy,
      accounts,
      assetRefs: refs,
      targetRole: current?.targetRole ?? null,
      executed: current?.executed ?? false,
      currencyCode,
    });

    const performance = await this.performanceService.build({
      range,
      securityByRole,
      asOf,
    });

    const pricesAsOf = await this.priceService.latestPriceDate([
      ...securityByRole.values(),
    ]);

    // The simulation charges the configured per-trade commission against the
    // capital the strategy actually runs, so it needs the portfolio's value.
    const backtest = await this.backtestService.build({
      strategy,
      signals,
      safeSecurityId: securityByRole.get("SAFE") ?? null,
      notional: position?.totalMarketValue ?? null,
      asOf,
    });
    const next = this.nextEvaluation(strategy, asOf);

    const warnings: GemWarning[] = [];
    if (unmappedRoles.length > 0) {
      warnings.push({ code: "UNMAPPED_ROLE", roles: unmappedRoles });
    }
    if (signals.length === 0) {
      warnings.push({ code: "FIRST_RUN" });
    } else if (!current) {
      // History exists but the period governing today could not be evaluated --
      // missing prices for the absolute test, so there is no signal to act on.
      warnings.push({ code: "CALCULATION_FAILED" });
    }
    if (
      current &&
      Object.values(current.momentum).some((value) => value === null)
    ) {
      warnings.push({ code: "INCOMPLETE_HISTORY" });
    } else if (performance?.incomplete) {
      warnings.push({ code: "INCOMPLETE_HISTORY" });
    }
    if (accounts.length === 0 || !position) {
      warnings.push({ code: "NO_ACCOUNT" });
    } else if (noPosition) {
      warnings.push({ code: "NO_POSITION" });
    }
    if (
      pricesAsOf &&
      parseYmd(pricesAsOf).getTime() <
        parseYmd(asOf).getTime() - STALE_PRICE_DAYS * 86_400_000
    ) {
      warnings.push({ code: "STALE_PRICES" });
    }

    return {
      strategy: {
        id: strategy.id,
        name: strategy.name,
        cadence: strategy.cadence,
        lookbackMonths: strategy.lookbackMonths,
        taxRatePercent: strategy.taxRatePercent,
        commissionAmount: strategy.commissionAmount,
        nextEvaluationOn: next.on,
        daysUntilNextEvaluation: next.days,
        pricesAsOf,
        rulesSourceUrl: strategy.rulesSourceUrl,
        rulesSourceLabel: strategy.rulesSourceLabel,
        accounts,
      },
      strategies: await this.listStrategies(userId),
      assets: [...refs.values()],
      signal: current ? this.toSignalView(current, refs) : null,
      position,
      action,
      performance,
      history: signals.map((signal) => this.toHistoryEntry(signal, refs)),
      backtest,
      warnings,
    };
  }

  /**
   * Create or update the user's GEM configuration, then return the refreshed
   * report. Roles are replaced wholesale when `assets` is supplied so a role can
   * be cleared by sending a null security.
   */
  async updateConfig(
    userId: string,
    dto: UpdateGemStrategyDto,
    range: GemRange = "1Y",
    strategyId?: string,
  ): Promise<GemStrategyReportView> {
    const configured = await withScopedDb(this.dataSource, async (manager) => {
      if (dto.accountIds && dto.accountIds.length > 0) {
        const wanted = [...new Set(dto.accountIds)];
        const owned = await manager.getRepository(Account).find({
          where: { id: In(wanted), userId },
          select: { id: true },
        });
        if (owned.length !== wanted.length) {
          throw new NotFoundException(
            tr("errors.strategies.accountNotFound", "Account not found"),
          );
        }
      }

      const securityIds = (dto.assets ?? [])
        .map((asset) => asset.securityId)
        .filter((id): id is string => !!id);
      if (securityIds.length > 0) {
        const owned = await manager.getRepository(Security).find({
          where: { id: In(securityIds), userId },
          select: { id: true },
        });
        if (owned.length !== new Set(securityIds).size) {
          throw new NotFoundException(
            tr("errors.strategies.securityNotFound", "Security not found"),
          );
        }
      }

      const strategyRepo = manager.getRepository(GemStrategy);
      // Naming a scenario edits that one; omitting the id edits the first,
      // which is the only one for a user who never created a second.
      const existing = await strategyRepo.findOne({
        where: strategyId ? { id: strategyId, userId } : { userId },
        order: { createdAt: "ASC" },
      });
      if (strategyId && !existing) {
        throw new NotFoundException(
          tr("errors.strategies.strategyNotFound", "Strategy not found"),
        );
      }
      const strategy =
        existing ??
        strategyRepo.create({ userId, name: DEFAULT_STRATEGY_NAME });

      if (dto.name !== undefined) {
        const trimmed = dto.name.trim();
        if (trimmed.length > 0) strategy.name = trimmed;
      }
      if (dto.cadence !== undefined) strategy.cadence = dto.cadence;
      if (dto.lookbackMonths !== undefined) {
        strategy.lookbackMonths = dto.lookbackMonths;
      }
      if (dto.taxRatePercent !== undefined) {
        strategy.taxRatePercent = dto.taxRatePercent;
      }
      if (dto.commissionAmount !== undefined) {
        strategy.commissionAmount = dto.commissionAmount;
      }
      if (dto.rulesSourceUrl !== undefined) {
        strategy.rulesSourceUrl = dto.rulesSourceUrl;
      }
      if (dto.rulesSourceLabel !== undefined) {
        strategy.rulesSourceLabel = dto.rulesSourceLabel;
      }
      const saved = await strategyRepo.save(strategy);

      // Accounts are replaced wholesale: the form always sends the full set, so
      // an account left out of it is one the user removed from the strategy.
      if (dto.accountIds) {
        const accountRepo = manager.getRepository(GemStrategyAccount);
        const wanted = [...new Set(dto.accountIds)];
        const existingLinks = await accountRepo.find({
          where: { strategyId: saved.id },
        });
        const removed = existingLinks.filter(
          (link) => !wanted.includes(link.accountId),
        );
        if (removed.length > 0) await accountRepo.remove(removed);
        const kept = new Set(existingLinks.map((link) => link.accountId));
        const added = wanted
          .filter((accountId) => !kept.has(accountId))
          .map((accountId) =>
            accountRepo.create({ userId, strategyId: saved.id, accountId }),
          );
        if (added.length > 0) await accountRepo.save(added);
      }

      if (dto.assets) {
        const assetRepo = manager.getRepository(GemStrategyAsset);
        const stored = await assetRepo.find({
          where: { strategyId: saved.id },
        });
        const byRole = new Map(stored.map((asset) => [asset.role, asset]));
        // A role appears at most once. Sending it twice would insert a second
        // row and hit the (strategy_id, role) unique index; the last value the
        // caller sent is the one they meant.
        const incomingByRole = new Map(
          dto.assets.map((asset) => [asset.role, asset]),
        );
        for (const incoming of incomingByRole.values()) {
          const asset =
            byRole.get(incoming.role) ??
            assetRepo.create({
              userId,
              strategyId: saved.id,
              role: incoming.role,
            });
          asset.securityId = incoming.securityId ?? null;
          await assetRepo.save(asset);
        }
      }

      const assigned = await manager.getRepository(GemStrategyAsset).find({
        where: { strategyId: saved.id },
        select: { securityId: true },
      });
      return {
        id: saved.id,
        lookbackMonths: saved.lookbackMonths,
        cadence: saved.cadence,
        securityIds: assigned
          .map((asset) => asset.securityId)
          .filter((id): id is string => !!id),
      };
    });

    // Assigning the last role is the moment the strategy can produce a signal,
    // so fetch any history the instruments are missing before evaluating --
    // otherwise a just-created security leaves the first signal waiting on a
    // background job the user cannot see. Outside the transaction: this talks
    // to the quote provider.
    await this.backfillService.ensureHistory(
      userId,
      configured.securityIds,
      configured.lookbackMonths,
      configured.cadence,
    );

    return this.getReport(userId, range, configured.id);
  }

  /**
   * Start a new scenario. Nothing is copied from an existing one: a scenario
   * exists to differ, and the settings form is where it is made to.
   */
  async createStrategy(
    userId: string,
    name: string | undefined,
    range: GemRange = "1Y",
  ): Promise<GemStrategyReportView> {
    const created = await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(GemStrategy);
      const trimmed = name?.trim();
      return repo.save(
        repo.create({
          userId,
          name: trimmed && trimmed.length > 0 ? trimmed : DEFAULT_STRATEGY_NAME,
        }),
      );
    });
    return this.getReport(userId, range, created.id);
  }

  /**
   * Delete a scenario, with its role assignments, account links and evaluation
   * history -- all of which cascade from the row. Returns the report for
   * whatever scenario is left, or the unconfigured one when none is.
   */
  async removeStrategy(
    userId: string,
    strategyId: string,
    range: GemRange = "1Y",
  ): Promise<GemStrategyReportView> {
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(GemStrategy);
      const strategy = await repo.findOne({
        where: { id: strategyId, userId },
      });
      if (!strategy) {
        throw new NotFoundException(
          tr("errors.strategies.strategyNotFound", "Strategy not found"),
        );
      }
      await repo.remove(strategy);
    });
    return this.getReport(userId, range);
  }

  /** Record that the current operation was carried out, then re-read the report. */
  async markExecuted(
    userId: string,
    signalId: string,
    range: GemRange = "1Y",
    strategyId?: string,
  ): Promise<GemStrategyReportView> {
    const updated = await this.signalService.markExecuted(userId, signalId);
    if (!updated) {
      throw new NotFoundException(
        tr("errors.strategies.signalNotFound", "Strategy signal not found"),
      );
    }
    return this.getReport(userId, range, strategyId);
  }
}
