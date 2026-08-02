import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney, sumMoney } from "../common/round.util";
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
    userId: string,
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
            AND s.user_id = $2
          GROUP BY h.security_id, s.symbol, s.name, s.currency_code,
                   s.country_weightings, s.asset_weightings, s.sector_weightings`,
        [accountIds, userId],
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
   * Cash sitting in the strategy's accounts, per account, in each account's own
   * currency.
   *
   * Two shapes, because the app models brokerage accounts both ways: a
   * brokerage account paired with a linked `INVESTMENT_CASH` account holding
   * the balance, and a standalone investment account that carries its own. The
   * strategy picker offers the brokerage and standalone accounts (never the
   * cash half on its own), so the linked balances have to be found from the
   * chosen side -- and the link is stored from whichever account was created
   * second, hence both directions.
   *
   * Only a positive balance counts. A margin debit is money owed, not an asset
   * the switch can move, and treating it as off-target value would inflate the
   * purchase by the size of the debt.
   *
   * Investment accounts only. The picker offers nothing else, but the API takes
   * any account the user owns, and a chequing account attached to a strategy
   * must not quietly become money the report tells them to invest.
   */
  private async loadCash(
    userId: string,
    accountIds: string[],
  ): Promise<Array<{ amount: number; currencyCode: string }>> {
    if (accountIds.length === 0) return [];
    const rows: Array<{ current_balance: string; currency_code: string }> =
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `SELECT a.current_balance, a.currency_code
             FROM accounts a
            WHERE a.user_id = $2
              AND a.current_balance > 0
              AND a.account_type = 'INVESTMENT'
              AND (
                    (a.id = ANY($1::uuid[]) AND a.account_sub_type IS NULL)
                 OR (a.account_sub_type = 'INVESTMENT_CASH'
                     AND (a.linked_account_id = ANY($1::uuid[])
                          OR a.id IN (SELECT b.linked_account_id
                                        FROM accounts b
                                       WHERE b.id = ANY($1::uuid[])
                                         AND b.linked_account_id IS NOT NULL)))
              )`,
          [accountIds, userId],
        ),
      );
    return rows.map((row) => ({
      amount: Number(row.current_balance),
      currencyCode: row.currency_code,
    }));
  }

  /**
   * The breakdowns of one security that is not held -- the signal's target
   * usually is not, which is the whole point of the switch.
   *
   * Scoped by `user_id` as well as by id. The id reaching here comes from the
   * caller's own strategy, so today the filter changes no result; it is there
   * because at `RLS_MODE=off` the database enforces nothing, and the next
   * caller to pass an id from somewhere else should get no row rather than
   * another user's fund breakdown.
   */
  private async loadComposition(
    userId: string,
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
          WHERE id = $1 AND user_id = $2`,
        [securityId, userId],
      ),
    );
    return rows[0] ? toComposition(rows[0]) : EMPTY_COMPOSITION;
  }

  /**
   * Convert an amount from a security's currency into the report currency, or
   * null when no rate is available in either direction.
   *
   * Null rather than a rate of 1. A missing exchange rate is missing data
   * (`docs/financial-calculation-contract.md` sections 3 and 4), and passing
   * the foreign amount through unconverted does not degrade gracefully here:
   * every figure this report prints -- the total, the share held in the target
   * instrument, what a switch moves, the gain it realizes -- is a ratio or a
   * sum over these values, so one unconverted holding silently mis-states all
   * of them. The arithmetic in `gem-position.util` already turns a null value
   * into a null total, which is what the reader has to see.
   */
  private async convert(
    amount: number,
    from: string,
    to: string,
    cache: Map<string, number | null>,
  ): Promise<number | null> {
    if (!from || from === to) return amount;
    const key = `${from}->${to}`;
    if (!cache.has(key)) {
      const direct = await this.exchangeRateService.getLatestRate(from, to);
      if (direct !== null) {
        cache.set(key, direct);
      } else {
        const reverse = await this.exchangeRateService.getLatestRate(to, from);
        cache.set(key, reverse !== null && reverse !== 0 ? 1 / reverse : null);
      }
    }
    const rate = cache.get(key) ?? null;
    return rate === null ? null : amount * rate;
  }

  /** `convert` rounded to money, keeping the unknown state. */
  private async convertMoney(
    amount: number,
    from: string,
    to: string,
    cache: Map<string, number | null>,
  ): Promise<number | null> {
    const converted = await this.convert(amount, from, to, cache);
    return converted === null ? null : roundMoney(converted);
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
      userId,
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
      userId,
      accounts.map((account) => account.id),
    );
    const prices = await this.priceService.latestPrices([
      ...new Set([
        ...securityByRole.values(),
        ...aggregated.map((holding) => holding.securityId),
      ]),
    ]);

    const rateCache = new Map<string, number | null>();
    const valued: GemHolding[] = [];
    for (const holding of aggregated) {
      const role = roleBySecurity.get(holding.securityId) ?? null;
      const price = prices.get(holding.securityId);
      const marketValue =
        price === undefined
          ? null
          : await this.convertMoney(
              holding.quantity * price,
              holding.currencyCode,
              currencyCode,
              rateCache,
            );
      const costBasis =
        holding.costBasis === null
          ? null
          : await this.convertMoney(
              holding.costBasis,
              holding.currencyCode,
              currencyCode,
              rateCache,
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

    // Cash joins the comparison as one aggregated position. It is summed
    // rather than listed per account because the whole report sums across the
    // strategy's accounts, and a switch spends whatever is in them.
    const cashRows = await this.loadCash(
      userId,
      accounts.map((account) => account.id),
    );
    const cashAmounts = await Promise.all(
      // A zero balance is zero in every currency, so it needs no rate.
      cashRows
        .filter((row) => row.amount !== 0)
        .map((row) =>
          this.convertMoney(
            row.amount,
            row.currencyCode,
            currencyCode,
            rateCache,
          ),
        ),
    );
    // Cash is always "priced" (contract section 3) -- but a balance in a
    // currency with no rate to the report currency is still an unknown amount
    // of the report currency, and summing only the convertible balances would
    // report a subtotal as the cash position.
    const cashValue = cashAmounts.some((amount) => amount === null)
      ? null
      : sumMoney(cashAmounts as number[]);
    if (cashValue === null || cashValue > 0) {
      valued.push({
        role: null,
        securityId: null,
        symbol: null,
        name: null,
        // Cash has no unit count; the amount stands in so the dust filter and
        // the ordering treat it like any other position. Unknown reads as zero
        // units here; `buildPositionMath` keeps an unvalued cash row anyway,
        // because dropping it would hide the very balance it cannot value.
        quantity: cashValue ?? 0,
        marketValue: cashValue,
        // Cash is worth what it is worth: selling it realizes nothing. Unknown
        // value means unknown basis -- the two are the same number.
        costBasis: cashValue,
        isCash: true,
      });
    }

    const math = buildPositionMath(valued, targetRole, {
      securityId: target?.securityId ?? null,
      composition: await this.loadComposition(
        userId,
        target?.securityId ?? null,
      ),
    });

    const held = (holding: GemMatchedHolding): GemHeldAsset => ({
      role: holding.role,
      isCash: holding.isCash === true,
      securityId: holding.securityId,
      symbol: holding.symbol,
      name: holding.name,
      // A balance has no unit count, and printing its amount in the quantity
      // column would read as shares.
      quantity: holding.isCash ? null : holding.quantity,
      marketValue: holding.marketValue,
      isTargetInstrument: holding.isTargetInstrument,
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
      exactTargetPercent: math.exactTargetPercent,
      marketExposurePercent: math.marketExposurePercent,
      marketExposureAvailable: math.marketExposureAvailable,
      marketExposureDimension: math.marketExposureAvailable
        ? math.dimension
        : null,
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
      // Every position the switch sells, largest first. Cash is off target and
      // funds the purchase, but naming it here would ask for a trade nobody
      // places, so `sold` already leaves it out.
      sellPositions: math.sold.map(held),
      to: target,
      targetWeightPercent: 100,
      transferValue: math.transferValue,
      realizedGainLoss: math.realizedGainLoss,
      estimatedTax: estimateTax(math.realizedGainLoss, strategy.taxRatePercent),
      taxRatePercent: strategy.taxRatePercent,
      estimatedCommission: estimateCommission(
        strategy.commissionAmount,
        math.sellCount,
      ),
      estimatedTradeCount: math.sellCount + 1,
      partialMatchCount: math.sold.filter(
        (holding) => (holding.overlap ?? 0) > 0,
      ).length,
      accounts,
      currencyCode,
      executed,
    };

    return { position, action, noPosition: math.holdings.length === 0 };
  }
}
