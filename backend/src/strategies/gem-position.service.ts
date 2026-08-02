import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney, sumMoney } from "../common/round.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import {
  PortfolioCalculationService,
  ReplayedLot,
} from "../securities/portfolio-calculation.service";
import { GemPriceService } from "./gem-price.service";
import { BOUNDARY_LAG_DAYS } from "./gem-momentum.util";
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

/**
 * How old a stored exchange rate may be and still convert a reported figure.
 *
 * The same window the prices are held to, for the same reason: both are
 * observations of a market, and a total built from a fresh price and a stale
 * rate is no more knowable than one built from a stale price.
 */
const RATE_MAX_AGE_DAYS = BOUNDARY_LAG_DAYS;

/**
 * How far a replayed quantity may sit from the held one and still be the same
 * position. Matches the dust threshold the position arithmetic uses, so a
 * fractional residue left by a split is not read as a missing trade.
 */
const QUANTITY_TOLERANCE = 0.0001;

/** One security's holdings summed over the strategy's accounts. */
interface AggregatedHolding {
  securityId: string;
  symbol: string | null;
  name: string | null;
  quantity: number;
  /** Accounts this position is held in -- one sell order each. */
  accountIds: string[];
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
    private portfolioCalculation: PortfolioCalculationService,
  ) {}

  /** Currency each strategy account keeps its books in. */
  private async accountCurrencies(
    userId: string,
    accountIds: string[],
  ): Promise<Map<string, string>> {
    if (accountIds.length === 0) return new Map();
    const rows: Array<{ id: string; currency_code: string }> =
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `SELECT a.id, a.currency_code
             FROM accounts a
            WHERE a.id = ANY($1::uuid[]) AND a.user_id = $2`,
          [accountIds, userId],
        ),
      );
    return new Map(rows.map((row) => [row.id, row.currency_code]));
  }

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
      account_ids: string[];
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
                -- Which accounts hold it. A switch places one order per
                -- account, not one per instrument: the same fund held in two
                -- brokerage accounts is two sells.
                array_agg(DISTINCT h.account_id) AS account_ids,
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
      accountIds: row.account_ids ?? [],
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
  ): Promise<
    Array<{ accountId: string; amount: number; currencyCode: string }>
  > {
    if (accountIds.length === 0) return [];
    const rows: Array<{
      owner_account_id: string;
      current_balance: string;
      currency_code: string;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT
                -- The account the purchase is *placed on*, which is not always
                -- the row the balance sits on. A linked INVESTMENT_CASH account
                -- is a ledger, not somewhere you buy an ETF: reporting its own
                -- id counted an ordinary brokerage pair as two accounts and so
                -- charged two purchase commissions for one order.
                COALESCE(
                  CASE WHEN a.id = ANY($1::uuid[]) THEN a.id END,
                  CASE WHEN a.linked_account_id = ANY($1::uuid[])
                       THEN a.linked_account_id END,
                  (SELECT b.id
                     FROM accounts b
                    WHERE b.linked_account_id = a.id
                      AND b.id = ANY($1::uuid[])
                    LIMIT 1)
                ) AS owner_account_id,
                a.current_balance, a.currency_code
             FROM accounts a
            WHERE a.user_id = $2
              AND a.current_balance > 0
              AND a.account_type = 'INVESTMENT'
              AND (
                    -- A selected account that holds its own cash: either a
                    -- standalone investment account (no sub-type), or a
                    -- brokerage account with no linked cash half. The second
                    -- is reachable -- deleting the "- Cash" account of a pair
                    -- clears the survivor's link -- and findCashAccount
                    -- already treats it this way, so the balance really is the
                    -- cash ledger. Missing it made an account half in cash
                    -- read as 100% compliant with nothing to do.
                    (a.id = ANY($1::uuid[])
                     AND (a.account_sub_type IS NULL
                          OR (a.account_sub_type = 'INVESTMENT_BROKERAGE'
                              AND a.linked_account_id IS NULL)))
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
      accountId: row.owner_account_id,
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
      // Bounded to the same fortnight as the prices these amounts are struck
      // from. An unbounded rate fails the way the unbounded price did, only
      // more quietly: nothing on the page is denominated in the rate, so a
      // nine-month-old one simply makes every converted figure wrong by the
      // year's currency move.
      const direct = await this.exchangeRateService.getLatestRate(
        from,
        to,
        RATE_MAX_AGE_DAYS,
      );
      if (direct !== null) {
        cache.set(key, direct);
      } else {
        const reverse = await this.exchangeRateService.getLatestRate(
          to,
          from,
          RATE_MAX_AGE_DAYS,
        );
        cache.set(key, reverse !== null && reverse !== 0 ? 1 / reverse : null);
      }
    }
    const rate = cache.get(key) ?? null;
    return rate === null ? null : amount * rate;
  }

  /**
   * A holding's cost basis in the report currency, or null when it cannot be
   * established from what the transactions recorded.
   *
   * Three ways it stays unknown, and each is a real state rather than a
   * shortcut:
   *
   * - a lot with no average cost at all, which the holdings query already
   *   reports (an imported position nobody costed);
   * - an account whose books are in a currency other than the report's. The
   *   per-transaction rate translated the purchase into the *account's*
   *   currency, so a further conversion to the report currency would have to
   *   pick a rate for an aggregate spanning years -- there is no such rate,
   *   and today's is the wrong answer this method exists to avoid;
   * - a derived basis of zero, which for a position that is held means the
   *   transactions do not describe how it was acquired, not that it was free;
   * - **a replay that does not reproduce the position being valued.** An
   *   imported portfolio often carries the holding without every trade behind
   *   it, and a basis for 50 shares beside a market value for 100 is not a
   *   smaller basis, it is a basis for a different position. Reported as a
   *   gain it is mostly the cost of the shares nobody recorded: 100 shares
   *   worth 1,500 against a replayed 500 for half of them shows 1,000 of gain
   *   and 190 of tax where the truth is 500 and 95.
   *
   * The quantity check proves the history accounts for the *units*, not that
   * it accounts for what they cost. `ADD_SHARES` and `SPLIT` move quantity
   * without money, so a holding of 100 built from a purchase of 50 and an
   * `ADD_SHARES` of 50 reconciles and reports a basis covering the purchased
   * half. That is deliberate rather than overlooked: quantity-only actions
   * carry no cost anywhere in this application, so a zero-cost sleeve is the
   * app-wide meaning of those rows, and having the GEM report alone treat them
   * as unknown would make it disagree with every other cost figure the user
   * sees. If that meaning ever changes, this is a site that changes with it.
   */
  private historicalCostBasis(params: {
    holding: AggregatedHolding;
    accountCostBases: Map<string, ReplayedLot>;
    currencyByAccount: Map<string, string>;
    currencyCode: string;
  }): number | null {
    const { holding, accountCostBases, currencyByAccount, currencyCode } =
      params;
    if (holding.costBasis === null) return null;
    let total = 0;
    let replayedQuantity = 0;
    for (const accountId of holding.accountIds) {
      if (currencyByAccount.get(accountId) !== currencyCode) return null;
      const lot = accountCostBases.get(`${accountId}:${holding.securityId}`);
      if (lot === undefined) return null;
      total += lot.costBasis;
      replayedQuantity += lot.quantity;
    }
    // The replay has to account for the units actually held. The tolerance is
    // the dust threshold the position arithmetic already uses, so a fractional
    // residue from a split does not invalidate an otherwise complete history.
    if (Math.abs(replayedQuantity - holding.quantity) > QUANTITY_TOLERANCE) {
      return null;
    }
    return total > 0 ? roundMoney(total) : null;
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

    /**
     * Cost basis per (account, security), already translated at each
     * transaction's **own** exchange rate.
     *
     * The holdings table's `average_cost` is in the security's currency, and
     * converting that aggregate at today's rate answers a different question:
     * ten units bought at 100 USD when USD/PLN was 3.00 cost 3,000 PLN, and
     * re-converting the 1,000 USD at today's 4.00 says 4,000 PLN -- so an
     * unchanged foreign price reports a gain of exactly zero and a tax of
     * zero, when the truth is 1,000 PLN and 190 PLN. Historical cost needs
     * historical rates, which is what this already does when it walks the
     * transactions.
     */
    const accountCostBases =
      await this.portfolioCalculation.calculateCostBasisLotsInAccountCurrency(
        userId,
        accounts.map((account) => account.id),
      );
    const currencyByAccount = await this.accountCurrencies(
      userId,
      accounts.map((account) => account.id),
    );

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
      const costBasis = this.historicalCostBasis({
        holding,
        accountCostBases,
        currencyByAccount,
        currencyCode,
      });
      valued.push({
        role,
        securityId: holding.securityId,
        symbol: holding.symbol,
        name: holding.name,
        quantity: holding.quantity,
        accountIds: holding.accountIds,
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
    const cashAccountIds = [...new Set(cashRows.map((row) => row.accountId))];
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
        // Cash is spent, not sold, so it places no sell order of its own. The
        // accounts it sits in still buy, and they are counted from the
        // securities plus this list.
        accountIds: cashAccountIds,
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
        math.buyCount,
      ),
      estimatedTradeCount: math.sellCount + math.buyCount,
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
