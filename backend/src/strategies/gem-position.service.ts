import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney } from "../common/round.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemPriceService } from "./gem-price.service";
import {
  EMPTY_COMPOSITION,
  GemSecurityComposition,
  GemWeighting,
  overlapPercent,
} from "./gem-composition.util";
import {
  GemHolding,
  GemMatchedHolding,
  buildPositionMath,
  estimateCommission,
  estimateTax,
} from "./gem-position.util";
import {
  GemAccountRef,
  GemActionView,
  GemAssetRef,
  GemHeldAsset,
  GemPositionView,
} from "./gem-report.types";

export interface GemPositionResult {
  position: GemPositionView | null;
  action: GemActionView | null;
  /** True when the strategy has accounts but none of them holds anything. */
  noPosition: boolean;
}

/** One security's holdings summed over the strategy's accounts. */
interface AggregatedHolding {
  securityId: string;
  symbol: string | null;
  name: string | null;
  quantity: number;
  /** quantity * average cost, in the security's own currency; null when unknown. */
  costBasis: number | null;
  /** Currency the security is priced and costed in. */
  currencyCode: string;
  /** The breakdowns the security is described by, as stored. */
  composition: GemSecurityComposition;
}

/** One securities row's three breakdowns, in the shape the comparison wants. */
function toComposition(row: {
  country_weightings: GemWeighting[] | null;
  asset_weightings: GemWeighting[] | null;
  sector_weightings: Array<{ sector: string; weight: number }> | null;
}): GemSecurityComposition {
  return {
    COUNTRY: row.country_weightings ?? null,
    ASSET_CLASS: row.asset_weightings ?? null,
    // Sector rows key the name differently from the other two breakdowns.
    SECTOR:
      row.sector_weightings?.map((entry) => ({
        name: entry.sector,
        weight: entry.weight,
      })) ?? null,
  };
}

/**
 * Turns the strategy accounts' real holdings into the report's "your portfolio"
 * and "what should I do" blocks.
 *
 * A strategy can be run in several brokerage accounts at once -- the signal is
 * the same for all of them -- so holdings are summed per security across the
 * whole set and valued in the user's default currency, converting from each
 * security's own currency. The arithmetic lives in `gem-position.util`; this
 * class is the data access and the currency conversion around it.
 */
@Injectable()
export class GemPositionService {
  constructor(
    private dataSource: DataSource,
    private priceService: GemPriceService,
    private exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * Everything held in the strategy's accounts, summed per security across
   * them. Not filtered to the strategy's own instruments: GEM wants the whole
   * portfolio in one asset, so a holding the strategy never assigned is part of
   * what makes it non-compliant and part of what a switch has to sell.
   */
  private async loadHoldings(
    accountIds: string[],
  ): Promise<AggregatedHolding[]> {
    if (accountIds.length === 0) return [];
    const rows: Array<{
      security_id: string;
      symbol: string | null;
      name: string | null;
      quantity: string;
      cost_basis: string | null;
      currency_code: string;
      country_weightings: GemWeighting[] | null;
      asset_weightings: GemWeighting[] | null;
      sector_weightings: Array<{ sector: string; weight: number }> | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT h.security_id,
                s.symbol,
                s.name,
                SUM(h.quantity) AS quantity,
                -- A holding with no average cost makes the whole cost basis
                -- unknown rather than understated. SUM() skips NULL rows, so
                -- the CASE turns "one account is uncosted" into an unknown
                -- basis instead of a total that quietly omits it.
                CASE
                  WHEN bool_or(h.average_cost IS NULL) THEN NULL
                  ELSE SUM(h.quantity * h.average_cost)
                END AS cost_basis,
                s.currency_code,
                -- The breakdowns the compliance comparison runs on: what a
                -- fund contains decides how much of it is already on target,
                -- not whether its ticker matches.
                s.country_weightings,
                s.asset_weightings,
                s.sector_weightings
           FROM holdings h
           JOIN securities s ON s.id = h.security_id
          WHERE h.account_id = ANY($1::uuid[])
          GROUP BY h.security_id, s.symbol, s.name, s.currency_code,
                   s.country_weightings, s.asset_weightings, s.sector_weightings`,
        [accountIds],
      ),
    );
    return rows.map((row) => ({
      securityId: row.security_id,
      symbol: row.symbol,
      name: row.name,
      quantity: Number(row.quantity),
      costBasis: row.cost_basis === null ? null : Number(row.cost_basis),
      currencyCode: row.currency_code,
      composition: toComposition(row),
    }));
  }

  /**
   * The breakdowns of one security that is not held -- the signal's target
   * usually is not, which is the whole point of the switch.
   */
  private async loadComposition(
    securityId: string | null,
  ): Promise<GemSecurityComposition> {
    if (!securityId) return EMPTY_COMPOSITION;
    const rows: Array<{
      country_weightings: GemWeighting[] | null;
      asset_weightings: GemWeighting[] | null;
      sector_weightings: Array<{ sector: string; weight: number }> | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT country_weightings, asset_weightings, sector_weightings
           FROM securities
          WHERE id = $1`,
        [securityId],
      ),
    );
    return rows[0] ? toComposition(rows[0]) : EMPTY_COMPOSITION;
  }

  /** Convert an amount from a security's currency into the report currency. */
  private async convert(
    amount: number,
    from: string,
    to: string,
    cache: Map<string, number>,
  ): Promise<number> {
    if (!from || from === to) return amount;
    const key = `${from}->${to}`;
    let rate = cache.get(key);
    if (rate === undefined) {
      const direct = await this.exchangeRateService.getLatestRate(from, to);
      if (direct !== null) {
        rate = direct;
      } else {
        const reverse = await this.exchangeRateService.getLatestRate(to, from);
        // No rate either way: fall back to 1 rather than dropping the holding,
        // matching how the portfolio views degrade.
        rate = reverse !== null && reverse !== 0 ? 1 / reverse : 1;
      }
      cache.set(key, rate);
    }
    return amount * rate;
  }

  async build(params: {
    userId: string;
    strategy: GemStrategy;
    /** Accounts the strategy is run in; their holdings are summed. */
    accounts: GemAccountRef[];
    /** Role -> instrument, for every role including unmapped ones. */
    assetRefs: Map<GemAssetRole, GemAssetRef>;
    targetRole: GemAssetRole | null;
    /** Whether the current signal's operation was already marked executed. */
    executed: boolean;
    /** Currency the report reports money in (the user's default). */
    currencyCode: string;
  }): Promise<GemPositionResult> {
    const {
      strategy,
      accounts,
      assetRefs,
      targetRole,
      executed,
      currencyCode,
    } = params;
    const target = targetRole ? (assetRefs.get(targetRole) ?? null) : null;

    if (accounts.length === 0) {
      return { position: null, action: null, noPosition: false };
    }

    const securityByRole = new Map<GemAssetRole, string>();
    for (const [role, ref] of assetRefs) {
      if (ref.securityId) securityByRole.set(role, ref.securityId);
    }
    const roleBySecurity = new Map(
      [...securityByRole].map(([role, securityId]) => [securityId, role]),
    );
    const aggregated = await this.loadHoldings(
      accounts.map((account) => account.id),
    );
    const prices = await this.priceService.latestPrices([
      ...new Set([
        ...securityByRole.values(),
        ...aggregated.map((holding) => holding.securityId),
      ]),
    ]);

    const rateCache = new Map<string, number>();
    const valued: GemHolding[] = [];
    for (const holding of aggregated) {
      const role = roleBySecurity.get(holding.securityId) ?? null;
      const price = prices.get(holding.securityId);
      const marketValue =
        price === undefined
          ? null
          : roundMoney(
              await this.convert(
                holding.quantity * price,
                holding.currencyCode,
                currencyCode,
                rateCache,
              ),
            );
      const costBasis =
        holding.costBasis === null
          ? null
          : roundMoney(
              await this.convert(
                holding.costBasis,
                holding.currencyCode,
                currencyCode,
                rateCache,
              ),
            );
      valued.push({
        role,
        securityId: holding.securityId,
        symbol: holding.symbol,
        name: holding.name,
        quantity: holding.quantity,
        marketValue,
        costBasis,
        composition: holding.composition,
      });
    }

    const math = buildPositionMath(valued, targetRole, {
      securityId: target?.securityId ?? null,
      composition: await this.loadComposition(target?.securityId ?? null),
    });

    const held = (holding: GemMatchedHolding): GemHeldAsset => ({
      role: holding.role,
      securityId: holding.securityId,
      symbol: holding.symbol,
      name: holding.name,
      quantity: holding.quantity,
      marketValue: holding.marketValue,
      matchPercent: overlapPercent(holding.overlap),
      matchedByInstrument: holding.matchedByInstrument,
      matchedMarkets: holding.matchedMarkets.map((market) => ({
        name: market.name,
        percent: overlapPercent(market.weight) as number,
      })),
    });

    const position: GemPositionView = {
      accounts,
      holdings: math.holdings.map(held),
      current: math.current ? held(math.current) : null,
      target,
      compliancePercent: math.compliancePercent,
      changeRequired: math.changeRequired,
      totalMarketValue: math.totalMarketValue,
      basis: math.basis,
      dimension: math.dimension,
      requiredDimension: math.requiredDimension,
      instrumentMatchedCount: math.instrumentMatchedCount,
      currencyCode,
    };

    const action: GemActionView = {
      required: math.changeRequired && target !== null,
      from: math.offTarget[0] ? held(math.offTarget[0]) : null,
      fromCount: math.offTarget.length,
      to: target,
      targetWeightPercent: 100,
      transferValue: math.transferValue,
      realizedGainLoss: math.realizedGainLoss,
      estimatedTax: estimateTax(math.realizedGainLoss, strategy.taxRatePercent),
      taxRatePercent: strategy.taxRatePercent,
      estimatedCommission: estimateCommission(
        strategy.commissionAmount,
        math.offTarget.length,
      ),
      estimatedTradeCount: math.offTarget.length + 1,
      accounts,
      currencyCode,
      executed,
    };

    return { position, action, noPosition: math.holdings.length === 0 };
  }
}
