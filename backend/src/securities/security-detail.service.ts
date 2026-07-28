import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  roundMoney,
  roundToDecimals,
  sumMoney,
  sumQuantity,
} from "../common/round.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import { Security } from "./entities/security.entity";
import { InvestmentAction } from "./entities/investment-transaction.entity";
import { SecuritiesService } from "./securities.service";
import { PortfolioService } from "./portfolio.service";
import { PortfolioCalculationService } from "./portfolio-calculation.service";
import {
  InvestmentTransactionsService,
  SecurityHistoryTransaction,
} from "./investment-transactions.service";

/**
 * The position in one account holding this security. Money comes in two
 * currencies because a security has a single quote currency but can be held in
 * an account denominated in another: the security's own currency is what the
 * price and average cost are quoted in, the account's is what the holder's
 * statement shows. The detail page renders both (discussion #964).
 */
export interface SecurityDetailAccountPosition {
  accountId: string;
  accountName: string;
  accountCurrencyCode: string;
  isClosed: boolean;
  quantity: number;
  /** Average cost per unit, in the security's currency. */
  averageCost: number;
  /** Cost basis in the security's currency. */
  costBasis: number;
  /**
   * Cost basis in the account's currency, from the historical rates on the buy
   * legs (not a current-rate conversion) -- reused verbatim from the portfolio
   * calculation so the two screens agree.
   */
  costBasisAccountCurrency: number;
  /** Market value in the security's currency; null when no price is known. */
  marketValue: number | null;
  /** Market value converted to the account's currency at the current rate. */
  marketValueAccountCurrency: number | null;
  /** Unrealized gain in the security's currency. */
  gainLoss: number | null;
  /** Unrealized gain in the account's currency. */
  gainLossAccountCurrency: number | null;
  gainLossPercent: number | null;
}

/** The aggregate position across every account, for the summary cards. */
export interface SecurityDetailPosition {
  quantity: number;
  /** Quantity-weighted average cost per unit, in the security's currency. */
  averageCost: number;
  /** Latest known price, in the security's currency. */
  currentPrice: number | null;
  costBasis: number;
  costBasisDefaultCurrency: number;
  marketValue: number | null;
  marketValueDefaultCurrency: number | null;
  gainLoss: number | null;
  gainLossDefaultCurrency: number | null;
  gainLossPercent: number | null;
}

/**
 * Lifetime activity totals for the Position info card. All amounts are in the
 * security's currency, matching how the existing transaction-history modal
 * renders each row's `totalAmount`.
 */
export interface SecurityDetailActivity {
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  /** Cash paid in on BUY legs, commission included. */
  totalInvested: number;
  /** Cash taken out on SELL legs, commission deducted. */
  totalSold: number;
  /** Dividends, interest and distributed capital gains received. */
  dividends: number;
  /** Commission across every leg. */
  fees: number;
  /** Realized gain from the average-cost replay, this security only. */
  realizedGain: number;
  transactionCount: number;
}

export interface SecurityDetail {
  security: Security;
  /** The user's reporting currency, for the aggregate `*DefaultCurrency` fields. */
  defaultCurrency: string;
  position: SecurityDetailPosition;
  accounts: SecurityDetailAccountPosition[];
  activity: SecurityDetailActivity;
  /** False for a security that has never been transacted. */
  hasTransactions: boolean;
  /** True when the security was held and has since been sold down to nothing. */
  isPositionClosed: boolean;
}

/** Actions whose `totalAmount` is money paid to acquire shares. */
const INVESTED_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
]);

/** Actions whose `totalAmount` is income rather than a change of position. */
const INCOME_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.DIVIDEND,
  InvestmentAction.INTEREST,
  InvestmentAction.CAPITAL_GAIN,
]);

/**
 * Everything the security detail page needs beyond the security row itself:
 * the position (aggregate and per account), and the lifetime activity totals.
 *
 * Deliberately a composition of existing services rather than new arithmetic.
 * Cost basis, market value and realized gain are the portfolio's own numbers --
 * recomputing them here would let this page drift from the Portfolio and
 * Reports screens, which is exactly the class of bug the "shared logic lives on
 * the domain service" rule exists to prevent.
 */
@Injectable()
export class SecurityDetailService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly securitiesService: SecuritiesService,
    private readonly portfolioService: PortfolioService,
    private readonly calculationService: PortfolioCalculationService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
  ) {}

  async getDetail(userId: string, securityId: string): Promise<SecurityDetail> {
    // Validates ownership and existence, and works for inactive securities.
    const security = await this.securitiesService.findOne(userId, securityId);

    const [defaultCurrency, history] = await Promise.all([
      this.resolveDefaultCurrency(userId),
      this.investmentTransactionsService.getSecurityTransactionHistory(
        userId,
        securityId,
      ),
    ]);

    // The whole-portfolio summary is the only place cost basis and market value
    // are computed canonically, so the position is filtered out of it rather
    // than recalculated. It costs more work than a single-security query would,
    // but it guarantees the figures here match the Portfolio page.
    const summary = await this.portfolioService.getPortfolioSummary(userId);

    const closedByAccountId = new Map(
      history.accounts.map((account) => [account.accountId, account.isClosed]),
    );

    const rateCache = new Map<string, number>();
    const accounts: SecurityDetailAccountPosition[] = [];

    for (const accountGroup of summary.holdingsByAccount) {
      const holding = accountGroup.holdings.find(
        (h) => h.securityId === securityId,
      );
      if (!holding) continue;

      const marketValueAccountCurrency =
        holding.marketValue === null
          ? null
          : roundMoney(
              await this.calculationService.convertToDefault(
                holding.marketValue,
                holding.currencyCode,
                accountGroup.currencyCode,
                rateCache,
              ),
            );

      accounts.push({
        accountId: accountGroup.accountId,
        accountName: accountGroup.accountName,
        accountCurrencyCode: accountGroup.currencyCode,
        isClosed: closedByAccountId.get(accountGroup.accountId) ?? false,
        quantity: holding.quantity,
        averageCost: holding.averageCost,
        costBasis: roundMoney(holding.costBasis),
        costBasisAccountCurrency: roundMoney(holding.costBasisAccountCurrency),
        marketValue:
          holding.marketValue === null ? null : roundMoney(holding.marketValue),
        marketValueAccountCurrency,
        gainLoss:
          holding.gainLoss === null ? null : roundMoney(holding.gainLoss),
        gainLossAccountCurrency:
          marketValueAccountCurrency === null
            ? null
            : roundMoney(
                marketValueAccountCurrency - holding.costBasisAccountCurrency,
              ),
        gainLossPercent: holding.gainLossPercent,
      });
    }

    const position = await this.buildAggregatePosition(
      accounts,
      defaultCurrency,
      summary.holdings.find((h) => h.securityId === securityId)?.currentPrice ??
        null,
      rateCache,
    );

    const activity = await this.buildActivity(
      userId,
      securityId,
      history.transactions,
      history.accounts.map((a) => a.accountId),
    );

    return {
      security,
      defaultCurrency,
      position,
      accounts,
      activity,
      hasTransactions: history.transactions.length > 0,
      // "Closed" is specifically *was held, now isn't*: a security that was
      // never traded gets the no-data state instead, not a closed-position one.
      isPositionClosed:
        history.transactions.length > 0 && accounts.length === 0,
    };
  }

  /**
   * Roll the per-account rows up into one position. Quantities and
   * security-currency amounts add directly (same unit); the reporting-currency
   * figures convert per account, because each account's holding may sit in a
   * different currency.
   */
  private async buildAggregatePosition(
    accounts: readonly SecurityDetailAccountPosition[],
    defaultCurrency: string,
    currentPrice: number | null,
    rateCache: Map<string, number>,
  ): Promise<SecurityDetailPosition> {
    // Quantities carry 8 decimals, money 4; summing the two the same way would
    // round a fractional crypto position away.
    const quantity = sumQuantity(accounts.map((a) => a.quantity));
    const costBasis = sumMoney(accounts.map((a) => a.costBasis));

    // A missing price anywhere makes the total meaningless, so the whole
    // aggregate goes null rather than silently reporting a partial value.
    const hasEveryPrice =
      accounts.length > 0 && accounts.every((a) => a.marketValue !== null);
    const marketValue = hasEveryPrice
      ? sumMoney(accounts.map((a) => a.marketValue as number))
      : null;

    const costBasisDefaultCurrency = sumMoney(
      await Promise.all(
        accounts.map((a) =>
          this.calculationService.convertToDefault(
            a.costBasisAccountCurrency,
            a.accountCurrencyCode,
            defaultCurrency,
            rateCache,
          ),
        ),
      ),
    );

    const marketValueDefaultCurrency = hasEveryPrice
      ? sumMoney(
          await Promise.all(
            accounts.map((a) =>
              this.calculationService.convertToDefault(
                a.marketValueAccountCurrency as number,
                a.accountCurrencyCode,
                defaultCurrency,
                rateCache,
              ),
            ),
          ),
        )
      : null;

    const gainLoss =
      marketValue === null ? null : roundMoney(marketValue - costBasis);
    const gainLossDefaultCurrency =
      marketValueDefaultCurrency === null
        ? null
        : roundMoney(marketValueDefaultCurrency - costBasisDefaultCurrency);

    return {
      quantity,
      // Weighted by construction: total cost over total units, not a mean of
      // per-account averages (which would misweight unequal positions). Kept at
      // the 6dp precision `holdings.average_cost` stores, because a sub-cent
      // quote (LSE pennies, a crypto pair) rounds to zero at the money 4dp.
      averageCost:
        quantity === 0 ? 0 : roundToDecimals(costBasis / quantity, 6),
      currentPrice,
      costBasis,
      costBasisDefaultCurrency,
      marketValue,
      marketValueDefaultCurrency,
      gainLoss,
      gainLossDefaultCurrency,
      gainLossPercent:
        gainLoss === null || costBasis <= 0
          ? null
          : (gainLoss / costBasis) * 100,
    };
  }

  private async buildActivity(
    userId: string,
    securityId: string,
    transactions: readonly SecurityHistoryTransaction[],
    accountIds: readonly string[],
  ): Promise<SecurityDetailActivity> {
    // The replay is scoped to the accounts this security was actually traded
    // in, so a large portfolio does not pay for a full-history walk here.
    const realizedGains =
      accountIds.length > 0
        ? await this.investmentTransactionsService.getRealizedGains(userId, {
            accountIds: [...accountIds],
          })
        : [];

    const amountsFor = (
      predicate: (tx: SecurityHistoryTransaction) => boolean,
    ): number =>
      sumMoney(
        transactions.filter(predicate).map((tx) => Number(tx.totalAmount) || 0),
      );

    return {
      // The history is ordered oldest-first by the service that builds it.
      firstTransactionDate: transactions[0]?.transactionDate ?? null,
      lastTransactionDate:
        transactions[transactions.length - 1]?.transactionDate ?? null,
      totalInvested: amountsFor((tx) => INVESTED_ACTIONS.has(tx.action)),
      totalSold: amountsFor((tx) => tx.action === InvestmentAction.SELL),
      dividends: amountsFor((tx) => INCOME_ACTIONS.has(tx.action)),
      fees: sumMoney(transactions.map((tx) => Number(tx.commission) || 0)),
      realizedGain: sumMoney(
        realizedGains
          .filter((entry) => entry.securityId === securityId)
          .map((entry) => entry.realizedGain),
      ),
      transactionCount: transactions.length,
    };
  }

  private async resolveDefaultCurrency(userId: string): Promise<string> {
    const pref = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return pref?.defaultCurrency || "CAD";
  }
}
