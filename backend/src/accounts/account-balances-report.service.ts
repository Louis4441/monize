import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { FxAggregate } from "../common/fx-aggregate";
import { convertWithRateLookup } from "../common/currency-conversion.util";
import { roundMoney } from "../common/round.util";
import { applyActionToQuantity } from "../securities/investment-replay.util";

/**
 * One account's worth at the end of a single day.
 *
 * `docs/specs/account-balances-as-of.md` is canonical for what each field means
 * and when it is allowed to be `null`; the short version is that `balance` is a
 * ledger sum the database always knows, and `marketValue` is a *total* -- so it
 * is `null` unless every position in the account was both priced and converted.
 */
export interface AccountBalanceAsOf {
  accountId: string;
  currencyCode: string;
  balance: number;
  marketValue: number | null;
  knownMarketValueSubtotal: number;
  unpricedHoldingsCount: number;
  missingRatePairs: string[];
  pricesComplete: boolean;
  fxComplete: boolean;
  valuationComplete: boolean;
}

export interface AccountBalancesAsOfResponse {
  /** Echoes the date the figures were measured at, so the payload carries its own request key. */
  asOfDate: string;
  accounts: AccountBalanceAsOf[];
}

/** A share position is treated as closed below this, matching HoldingsService. */
const QUANTITY_EPSILON = 0.00000001;

/**
 * Point-in-time balances for the Account Balances report (issue #1198).
 *
 * Kept apart from `AccountsService` because it answers a different question:
 * that service maintains `current_balance`, a running figure the ledger writes
 * keep up to date, while this one measures every account at a date the caller
 * chose -- which may be years back or years ahead.
 */
@Injectable()
export class AccountBalancesReportService {
  private readonly logger = new Logger(AccountBalancesReportService.name);

  constructor(private dataSource: DataSource) {}

  private scopedQuery<T = any>(sql: string, params?: any[]): Promise<T> {
    return withScopedDb(this.dataSource, (m) => m.query(sql, params));
  }

  /**
   * Every account the caller can see, valued at the end of `asOfDate`.
   *
   * `jointAccountIds` are accounts another owner shared with the caller; the
   * controller has already authorized them, and the predicate widens to those
   * exact ids and nothing else -- the same shape `getDailyBalances` uses.
   */
  async getBalancesAsOf(
    userId: string,
    asOfDate: string,
    jointAccountIds: string[] = [],
  ): Promise<AccountBalancesAsOfResponse> {
    const accounts: Array<{
      id: string;
      currency_code: string;
      account_type: string;
      account_sub_type: string | null;
    }> = await this.scopedQuery(
      `SELECT id, currency_code, account_type, account_sub_type
         FROM accounts
        WHERE user_id = $1 OR id = ANY($2::UUID[])`,
      [userId, jointAccountIds],
    );

    if (accounts.length === 0) return { asOfDate, accounts: [] };

    const ledgerBalances = await this.ledgerBalances(
      userId,
      asOfDate,
      jointAccountIds,
    );

    // Only these hold securities. The cash sleeve of a linked pair is an
    // ordinary ledger account and is excluded here, exactly as it is everywhere
    // else -- counting it twice is the double-count the pairing exists to avoid.
    const holdingsAccounts = accounts.filter(
      (a) =>
        a.account_type === "INVESTMENT" &&
        (a.account_sub_type === "INVESTMENT_BROKERAGE" || !a.account_sub_type),
    );
    const marketValues = await this.marketValuesAsOf(
      holdingsAccounts.map((a) => ({
        id: a.id,
        currencyCode: a.currency_code,
      })),
      asOfDate,
    );

    return {
      asOfDate,
      accounts: accounts.map((a) => {
        const valuation = marketValues.get(a.id);
        // A row that holds no securities has no market value to report -- that
        // is "does not apply", which is why the completeness flag stays true
        // rather than following the null.
        if (!valuation) {
          return {
            accountId: a.id,
            currencyCode: a.currency_code,
            balance: ledgerBalances.get(a.id) ?? 0,
            marketValue: null,
            knownMarketValueSubtotal: 0,
            unpricedHoldingsCount: 0,
            missingRatePairs: [],
            pricesComplete: true,
            fxComplete: true,
            valuationComplete: true,
          };
        }
        return {
          accountId: a.id,
          currencyCode: a.currency_code,
          balance: ledgerBalances.get(a.id) ?? 0,
          ...valuation,
        };
      }),
    };
  }

  /**
   * Opening balance plus every non-void, non-child transaction dated on or
   * before `asOfDate` -- the same expression `recalculateCurrentBalance` uses,
   * with the caller's date in place of today.
   */
  private async ledgerBalances(
    userId: string,
    asOfDate: string,
    jointAccountIds: string[],
  ): Promise<Map<string, number>> {
    const rows: Array<{ id: string; balance: string }> = await this.scopedQuery(
      `SELECT a.id,
                COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance
           FROM accounts a
           LEFT JOIN transactions t ON t.account_id = a.id
            AND (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date <= $2
          WHERE a.user_id = $1 OR a.id = ANY($3::UUID[])
          GROUP BY a.id, a.opening_balance`,
      [userId, asOfDate, jointAccountIds],
    );

    return new Map(rows.map((r) => [r.id, roundMoney(Number(r.balance))]));
  }

  /**
   * Replay each holdings account to `asOfDate` and value what it held.
   *
   * The price used is the security's last close **on or before** the date, and
   * the rate is the last stored rate on or before it. That is what makes a
   * future date meaningful: the position is carried at the most recent figure
   * anybody knows, which is the only honest answer about a day that has not
   * happened yet. It is not a forecast, and nothing here extrapolates.
   */
  private async marketValuesAsOf(
    holdingsAccounts: Array<{ id: string; currencyCode: string }>,
    asOfDate: string,
  ): Promise<
    Map<
      string,
      {
        marketValue: number | null;
        knownMarketValueSubtotal: number;
        unpricedHoldingsCount: number;
        missingRatePairs: string[];
        pricesComplete: boolean;
        fxComplete: boolean;
        valuationComplete: boolean;
      }
    >
  > {
    const result = new Map<
      string,
      {
        marketValue: number | null;
        knownMarketValueSubtotal: number;
        unpricedHoldingsCount: number;
        missingRatePairs: string[];
        pricesComplete: boolean;
        fxComplete: boolean;
        valuationComplete: boolean;
      }
    >();
    if (holdingsAccounts.length === 0) return result;

    const accountIds = holdingsAccounts.map((a) => a.id);
    const transactions: Array<{
      account_id: string;
      security_id: string;
      action: string;
      quantity: string | null;
    }> = await this.scopedQuery(
      `SELECT account_id, security_id, action, quantity
         FROM investment_transactions
        WHERE account_id = ANY($1::UUID[])
          AND security_id IS NOT NULL
          AND status != 'VOID'
          AND transaction_date <= $2
        ORDER BY transaction_date ASC, created_at ASC`,
      [accountIds, asOfDate],
    );

    // accountId -> securityId -> quantity, folded through the one reducer every
    // other replay in the codebase uses (a SPLIT's quantity is a ratio).
    const positions = new Map<string, Map<string, number>>();
    for (const tx of transactions) {
      let bySecurity = positions.get(tx.account_id);
      if (!bySecurity) {
        bySecurity = new Map<string, number>();
        positions.set(tx.account_id, bySecurity);
      }
      bySecurity.set(
        tx.security_id,
        applyActionToQuantity(
          bySecurity.get(tx.security_id) ?? 0,
          tx.action,
          Number(tx.quantity ?? 0),
        ),
      );
    }

    const heldSecurityIds = [
      ...new Set(
        [...positions.values()].flatMap((bySecurity) =>
          [...bySecurity.entries()]
            .filter(([, qty]) => Math.abs(qty) > QUANTITY_EPSILON)
            .map(([securityId]) => securityId),
        ),
      ),
    ];

    const [prices, securityCurrencies] = await Promise.all([
      this.closingPricesAsOf(heldSecurityIds, asOfDate),
      this.securityCurrencies(heldSecurityIds),
    ]);
    const rates = await this.storedRatesAsOf(asOfDate);

    for (const account of holdingsAccounts) {
      const bySecurity = positions.get(account.id);
      const aggregate = new FxAggregate();
      const unpriced = new Set<string>();

      for (const [securityId, quantity] of bySecurity ?? []) {
        if (Math.abs(quantity) <= QUANTITY_EPSILON) continue;
        const price = prices.get(securityId);
        // An unpriced position is unknown, not free. Folding it in at zero is
        // what makes a partial valuation look like a settled one.
        if (price == null) {
          unpriced.add(securityId);
          continue;
        }
        const securityCurrency =
          securityCurrencies.get(securityId) ?? account.currencyCode;
        aggregate.add(
          convertWithRateLookup(
            quantity * price,
            securityCurrency,
            account.currencyCode,
            (from, to) => rates.get(`${from}->${to}`),
          ),
          securityCurrency,
          account.currencyCode,
        );
      }

      const missingRatePairs = aggregate.missingPairs;
      if (missingRatePairs.length > 0) {
        this.logger.warn(
          `Account ${account.id} valuation at ${asOfDate} omits positions with no exchange rate (${missingRatePairs.join(", ")})`,
        );
      }
      const complete = aggregate.isComplete && unpriced.size === 0;
      const knownSubtotal = roundMoney(aggregate.knownSubtotal);

      result.set(account.id, {
        // An account holding nothing is worth zero, not unknown -- the
        // aggregate returns 0 for that case and it stays complete.
        marketValue: complete ? knownSubtotal : null,
        knownMarketValueSubtotal: knownSubtotal,
        unpricedHoldingsCount: unpriced.size,
        missingRatePairs,
        pricesComplete: unpriced.size === 0,
        fxComplete: aggregate.isComplete,
        valuationComplete: complete,
      });
    }

    return result;
  }

  /** Each security's last close on or before `asOfDate`; absent when it has none. */
  private async closingPricesAsOf(
    securityIds: string[],
    asOfDate: string,
  ): Promise<Map<string, number>> {
    if (securityIds.length === 0) return new Map();
    const rows: Array<{ security_id: string; close_price: string }> =
      await this.scopedQuery(
        `SELECT DISTINCT ON (security_id) security_id, close_price
           FROM security_prices
          WHERE security_id = ANY($1::UUID[])
            AND price_date <= $2
          ORDER BY security_id, price_date DESC`,
        [securityIds, asOfDate],
      );
    return new Map(rows.map((r) => [r.security_id, Number(r.close_price)]));
  }

  private async securityCurrencies(
    securityIds: string[],
  ): Promise<Map<string, string>> {
    if (securityIds.length === 0) return new Map();
    const rows: Array<{ id: string; currency_code: string }> =
      await this.scopedQuery(
        `SELECT id, currency_code FROM securities WHERE id = ANY($1::UUID[])`,
        [securityIds],
      );
    return new Map(rows.map((r) => [r.id, r.currency_code]));
  }

  /**
   * The last stored rate for every pair on or before `asOfDate`, keyed
   * `"FROM->TO"`. `convertWithRateLookup` tries the reverse pair itself, so
   * only one direction needs to exist.
   */
  private async storedRatesAsOf(
    asOfDate: string,
  ): Promise<Map<string, number>> {
    const rows: Array<{
      from_currency: string;
      to_currency: string;
      rate: string;
    }> = await this.scopedQuery(
      `SELECT DISTINCT ON (from_currency, to_currency)
              from_currency, to_currency, rate
         FROM exchange_rates
        WHERE rate_date <= $1
        ORDER BY from_currency, to_currency, rate_date DESC`,
      [asOfDate],
    );
    return new Map(
      rows.map((r) => [`${r.from_currency}->${r.to_currency}`, Number(r.rate)]),
    );
  }
}
