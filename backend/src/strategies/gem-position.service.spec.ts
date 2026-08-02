import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemPositionService } from "./gem-position.service";
import { GemAssetRef } from "./gem-report.types";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const userId = "user-1";

const strategy = (overrides: Partial<GemStrategy> = {}): GemStrategy =>
  ({
    id: "strategy-1",
    userId,
    cadence: "MONTHLY",
    lookbackMonths: 12,
    taxRatePercent: 19,
    commissionAmount: 29.9,
    ...overrides,
  }) as GemStrategy;

const accounts = [
  { id: "acct-1", name: "Broker IRA" },
  { id: "acct-2", name: "Broker Taxable" },
];

const assetRefs = (): Map<GemAssetRole, GemAssetRef> =>
  new Map<GemAssetRole, GemAssetRef>([
    [
      "US_EQUITY",
      {
        role: "US_EQUITY",
        securityId: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
      },
    ],
    [
      "EX_US_EQUITY",
      { role: "EX_US_EQUITY", securityId: null, symbol: null, name: null },
    ],
    [
      "EM_EQUITY",
      {
        role: "EM_EQUITY",
        securityId: "sec-emim",
        symbol: "EMIM",
        name: "EM IMI ETF",
      },
    ],
    [
      "SAFE",
      {
        role: "SAFE",
        securityId: "sec-ief",
        symbol: "IEF",
        name: "Treasuries",
      },
    ],
  ]);

describe("GemPositionService", () => {
  let service: GemPositionService;
  let manager: ManagerMock;
  let priceService: { latestPrices: jest.Mock };
  let exchangeRates: { getLatestRate: jest.Mock };
  let portfolioCalculation: {
    calculateCostBasesInAccountCurrency: jest.Mock;
  };

  const build = (overrides: Record<string, unknown> = {}) =>
    service.build({
      userId,
      strategy: strategy(),
      accounts,
      assetRefs: assetRefs(),
      targetRole: "EM_EQUITY",
      executed: false,
      currencyCode: "USD",
      ...overrides,
    } as never);

  /**
   * Rows each of the service's three reads answers with. They go through one
   * `manager.query`, so the mock dispatches on the SQL: a blanket
   * `mockResolvedValue` would feed holding rows to the cash query, which then
   * reads a balance out of a column that is not there.
   */
  let holdingRows: Array<Record<string, unknown>>;
  let cashRows: Array<Record<string, unknown>>;
  let compositionRows: Array<Record<string, unknown>>;
  /** Currency each strategy account keeps its books in. */
  let accountCurrencyRows: Array<Record<string, unknown>>;

  beforeEach(() => {
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "51",
        cost_basis: "18281.46",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    cashRows = [];
    compositionRows = [];
    accountCurrencyRows = [
      { id: "acct-1", currency_code: "USD" },
      { id: "acct-2", currency_code: "USD" },
    ];
    manager.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM holdings")) return Promise.resolve(holdingRows);
      if (sql.includes("current_balance")) return Promise.resolve(cashRows);
      if (sql.includes("a.currency_code")) {
        return Promise.resolve(accountCurrencyRows);
      }
      return Promise.resolve(compositionRows);
    });
    priceService = {
      latestPrices: jest
        .fn()
        .mockResolvedValue(new Map([["sec-spy", 452.475]])),
    };
    exchangeRates = { getLatestRate: jest.fn().mockResolvedValue(null) };
    // Cost bases come from the transactions, translated at each one's own
    // historical rate. The default matches the base holding fixture so the
    // existing gain and tax expectations still describe a real acquisition.
    portfolioCalculation = {
      calculateCostBasesInAccountCurrency: jest
        .fn()
        .mockResolvedValue(new Map([["acct-1:sec-spy", 18281.46]])),
    };
    service = new GemPositionService(
      mocks.dataSource as never,
      priceService as never,
      exchangeRates as never,
      portfolioCalculation as never,
    );
  });

  it("describes the held position and the operation the signal requires", async () => {
    const result = await build();

    expect(result.position).toMatchObject({
      accounts,
      exactTargetPercent: 0,
      changeRequired: true,
      currencyCode: "USD",
    });
    expect(result.position?.current).toMatchObject({
      symbol: "SPY",
      quantity: 51,
    });
    expect(result.position?.current?.marketValue).toBeCloseTo(23076.225, 3);
    expect(result.position?.target?.symbol).toBe("EMIM");
    expect(result.action).toMatchObject({
      required: true,
      taxRatePercent: 19,
      // One holding to sell out of plus the target to buy: two commissions.
      estimatedTradeCount: 2,
      estimatedCommission: 59.8,
      executed: false,
      accounts,
    });
    expect(result.action?.estimatedTax).toBeCloseTo(911.01, 1);
    expect(result.noPosition).toBe(false);
  });

  it("sums the holdings of every strategy account in one query", async () => {
    await build();
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("FROM holdings");
    expect(sql).toContain("SUM(h.quantity)");
    expect(params[0]).toEqual(["acct-1", "acct-2"]);
    // Scoped by owner as well: the accounts already come from the user's own
    // strategy, but at RLS_MODE=off nothing else enforces it.
    expect(sql).toContain("s.user_id = $2");
    expect(params[1]).toBe("user-1");
    // Every holding counts, not just the strategy's own instruments.
    expect(params).toHaveLength(2);
  });

  it("counts an instrument the strategy never assigned", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: "3000",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
      {
        security_id: "sec-wtai",
        symbol: "WTAI",
        name: "AI ETF",
        quantity: "100",
        cost_basis: "5000",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    priceService.latestPrices.mockResolvedValue(
      new Map([
        ["sec-spy", 400],
        ["sec-wtai", 60],
      ]),
    );

    const result = await build();

    // 4000 in SPY plus 6000 in an instrument outside the strategy: none of it
    // is in the EM target, so the whole 10000 has to move.
    expect(result.position?.totalMarketValue).toBe(10000);
    expect(result.position?.exactTargetPercent).toBe(0);
    expect(result.position?.holdings.map((h) => h.symbol)).toEqual([
      "WTAI",
      "SPY",
    ]);
    expect(result.position?.holdings[0].role).toBeNull();
    expect(result.action?.transferValue).toBe(10000);
    // Both are named, largest first. "WTAI and 1 more" described a two-fund
    // portfolio as though it were in one of them.
    expect(result.action?.sellPositions.map((held) => held.symbol)).toEqual([
      "WTAI",
      "SPY",
    ]);
  });

  it("sells out of the off-target holding, not the largest one", async () => {
    holdingRows = [
      {
        security_id: "sec-emim",
        symbol: "EMIM",
        name: "EM IMI ETF",
        quantity: "200",
        cost_basis: "6000",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "5",
        cost_basis: "1500",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    priceService.latestPrices.mockResolvedValue(
      new Map([
        ["sec-emim", 35],
        ["sec-spy", 400],
      ]),
    );

    const result = await build();

    // EMIM is the target and the larger position, so the switch sells SPY.
    expect(result.position?.current?.symbol).toBe("EMIM");
    expect(result.action?.sellPositions.map((held) => held.symbol)).toEqual([
      "SPY",
    ]);
    expect(result.action?.transferValue).toBe(2000);
  });

  it("leaves the cost basis unknown when one account is uncosted", async () => {
    // The aggregate query returns NULL for the whole security when any of the
    // summed holdings has no average cost -- an understated basis would inflate
    // the realized result and the tax on it.
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "51",
        cost_basis: null,
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];

    const result = await build();

    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain("bool_or(h.average_cost IS NULL)");
    expect(result.action?.transferValue).toBeCloseTo(23076.225, 3);
    expect(result.action?.realizedGainLoss).toBeNull();
    expect(result.action?.estimatedTax).toBeNull();
  });

  it("converts a foreign-currency holding into the report currency", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: "1000",
        currency_code: "EUR",
        account_ids: ["acct-1"],
      },
    ];
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 200]]));
    exchangeRates.getLatestRate.mockResolvedValue(1.1);
    // What the purchase actually cost in the account's currency, translated
    // when it happened -- not the holdings table's EUR average re-converted at
    // today's rate.
    portfolioCalculation.calculateCostBasesInAccountCurrency.mockResolvedValue(
      new Map([["acct-1:sec-spy", 1100]]),
    );

    const result = await build();

    // Bounded by age: a rate is a price, and a nine-month-old one converts
    // every figure on the page by the wrong amount without saying so.
    expect(exchangeRates.getLatestRate).toHaveBeenCalledWith("EUR", "USD", 14);
    expect(result.position?.current?.marketValue).toBeCloseTo(2200, 2);
    expect(result.action?.realizedGainLoss).toBeCloseTo(1100, 2);
  });

  /**
   * The defect this replaced: cost basis was `SUM(quantity * average_cost)` in
   * the *security's* currency, converted at today's rate alongside the market
   * value. An unchanged foreign price then produced a gain of exactly zero,
   * because both sides moved with the currency.
   */
  it("values cost at the rates of the purchases, not today's", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: "1000",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    accountCurrencyRows = [{ id: "acct-1", currency_code: "PLN" }];
    // 10 units bought at 100 USD when USD/PLN was 3.00: 3,000 PLN.
    portfolioCalculation.calculateCostBasesInAccountCurrency.mockResolvedValue(
      new Map([["acct-1:sec-spy", 3000]]),
    );
    // Unchanged at 100 USD, but USD/PLN is now 4.00: 4,000 PLN.
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 100]]));
    exchangeRates.getLatestRate.mockResolvedValue(4);

    const result = await build({ currencyCode: "PLN" });

    expect(result.position?.current?.marketValue).toBeCloseTo(4000, 2);
    // 4,000 - 3,000. Converting the basis at today's rate gave 4,000 and
    // therefore a gain, and a tax, of zero.
    expect(result.action?.realizedGainLoss).toBeCloseTo(1000, 2);
    expect(result.action?.estimatedTax).toBeCloseTo(190, 2);
  });

  it("will not guess a cost basis held in another currency than the report", async () => {
    // The per-transaction rate translated each purchase into the *account's*
    // currency. Converting that multi-year aggregate into the report currency
    // would need a rate that does not exist, and today's is the wrong answer
    // this whole change exists to avoid.
    accountCurrencyRows = [{ id: "acct-1", currency_code: "EUR" }];
    portfolioCalculation.calculateCostBasesInAccountCurrency.mockResolvedValue(
      new Map([["acct-1:sec-spy", 15000]]),
    );

    const result = await build();

    expect(result.action?.realizedGainLoss).toBeNull();
    expect(result.action?.estimatedTax).toBeNull();
    // The market value is still knowable: it is a price today, not a history.
    expect(result.position?.totalMarketValue).toBeCloseTo(23076.225, 3);
  });

  it("falls back to the inverse rate", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: null,
        currency_code: "EUR",
        account_ids: ["acct-1"],
      },
    ];
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 100]]));
    exchangeRates.getLatestRate
      .mockResolvedValueOnce(null) // EUR -> USD unknown
      .mockResolvedValueOnce(0.5); // USD -> EUR known
    const result = await build();
    expect(result.position?.current?.marketValue).toBeCloseTo(2000, 2);
  });

  /**
   * The adversarial case for the missing-rate rule
   * (`docs/financial-calculation-contract.md` sections 3 and 4). This used to
   * convert at a rate of 1: a 1,000 EUR position was reported as 1,000 USD,
   * and because the report's figures are sums and ratios over these values,
   * the total, the transfer value and the tax estimate were all wrong by the
   * EUR/USD rate while reading as confident numbers.
   */
  it("reports an unconvertible holding as unvalued, never at parity", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: "800",
        currency_code: "EUR",
        account_ids: ["acct-1"],
      },
    ];
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 100]]));
    exchangeRates.getLatestRate.mockResolvedValue(null);

    const result = await build();

    // Nothing in the accounts can be valued, so there is no "largest
    // position" to name either.
    expect(result.position?.current).toBeNull();
    expect(result.position?.holdings[0].marketValue).toBeNull();
    expect(result.position?.totalMarketValue).toBeNull();
    // Nothing is in the target, so the share held in it is 0% of a denominator
    // that is itself unknown -- unknown, not "0% of 1,000".
    expect(result.position?.exactTargetPercent).toBeNull();
    expect(result.action?.transferValue).toBeNull();
    expect(result.action?.realizedGainLoss).toBeNull();
    expect(result.action?.estimatedTax).toBeNull();
    // The switch is still required: an off-target holding says so without
    // needing a price.
    expect(result.action?.required).toBe(true);
  });

  it("reports an unconvertible cash balance as unvalued, never at parity", async () => {
    cashRows = [
      {
        owner_account_id: "acct-1",
        current_balance: "5000",
        currency_code: "PLN",
      },
    ];
    exchangeRates.getLatestRate.mockResolvedValue(null);

    const result = await build();

    const cash = result.position?.holdings.find((held) => held.isCash);
    // Kept, not dropped: an unvalued balance is a balance of unknown size, and
    // dropping it would report the securities alone as the whole portfolio.
    expect(cash).toBeDefined();
    expect(cash?.marketValue).toBeNull();
    expect(result.position?.totalMarketValue).toBeNull();
    expect(result.action?.transferValue).toBeNull();
  });

  /**
   * Deleting the "- Cash" half of a brokerage pair clears the survivor's
   * `linked_account_id`, and from then on the brokerage account carries its own
   * balance -- `findCashAccount` already treats it that way. The cash query
   * matched neither of its two branches in that state, so an account half in
   * cash reported 100% in the target with nothing to do: the precise failure
   * counting cash as a position was added to prevent.
   */
  it("finds the cash of a brokerage account with no linked cash half", async () => {
    await build();

    const cashSql = manager.query.mock.calls
      .map(([sql]: [string]) => sql)
      .find((sql: string) => sql.includes("current_balance"));
    expect(cashSql).toContain("a.account_sub_type IS NULL");
    expect(cashSql).toContain("a.account_sub_type = 'INVESTMENT_BROKERAGE'");
    expect(cashSql).toContain("a.linked_account_id IS NULL");
  });

  /**
   * A linked INVESTMENT_CASH account is a ledger, not somewhere an ETF is
   * bought. Reporting its own id counted an ordinary brokerage pair -- one
   * account, as the user sees it -- as two buyers, and charged two purchase
   * commissions for the single order they will actually place.
   */
  it("attributes a linked cash balance to the brokerage account that trades", async () => {
    await build();

    const cashSql = manager.query.mock.calls
      .map(([sql]: [string]) => sql)
      .find((sql: string) => sql.includes("current_balance")) as string;

    // The selected account keeps its own id...
    expect(cashSql).toContain("CASE WHEN a.id = ANY($1::uuid[]) THEN a.id END");
    // ...a cash account pointing at a selected brokerage resolves to it...
    expect(cashSql).toContain("THEN a.linked_account_id END");
    // ...and so does one the selected brokerage points at.
    expect(cashSql).toContain("WHERE b.linked_account_id = a.id");
    expect(cashSql).toContain("AS owner_account_id");
  });

  it("charges one purchase for a brokerage account and its cash half", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "25",
        cost_basis: "9000",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    // The query resolves the linked cash row to the brokerage account, so both
    // rows name the same trading account.
    cashRows = [
      {
        owner_account_id: "acct-1",
        current_balance: "1000",
        currency_code: "USD",
      },
    ];
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 400]]));

    const result = await build();

    // One sell of SPY and one purchase of the target, both on acct-1. The
    // cash is spent, not sold, so it adds no order of its own.
    expect(result.action?.estimatedTradeCount).toBe(2);
    expect(result.action?.estimatedCommission).toBeCloseTo(59.8, 2);
  });

  it("charges a purchase in each of two independent brokerage accounts", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "25",
        cost_basis: "9000",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    cashRows = [
      {
        owner_account_id: "acct-2",
        current_balance: "5000",
        currency_code: "USD",
      },
    ];
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 400]]));

    const result = await build();

    // One sell on acct-1, then a purchase on each account: three orders.
    expect(result.action?.estimatedTradeCount).toBe(3);
    expect(result.action?.estimatedCommission).toBeCloseTo(89.7, 2);
  });

  it("counts one sell order per account a position is held in", async () => {
    holdingRows = [
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "20",
        cost_basis: "6000",
        currency_code: "USD",
        // The same fund in both of the strategy's accounts: two sells.
        account_ids: ["acct-1", "acct-2"],
      },
    ];
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 400]]));

    const result = await build();

    // Two sells plus a purchase in each account: four orders at 29.90.
    expect(result.action?.estimatedTradeCount).toBe(4);
    expect(result.action?.estimatedCommission).toBeCloseTo(119.6, 2);
  });

  it("returns nothing when the strategy has no accounts", async () => {
    const result = await build({ accounts: [] });
    expect(result).toEqual({ position: null, action: null, noPosition: false });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("reports empty strategy accounts as having no position", async () => {
    holdingRows = [];
    const result = await build();
    expect(result.noPosition).toBe(true);
    expect(result.position?.current).toBeNull();
    expect(result.action?.required).toBe(true);
    // Empty accounts move nothing, realize nothing and owe nothing. All three
    // are known; `null` said they could not be worked out.
    expect(result.action?.transferValue).toBe(0);
    expect(result.action?.realizedGainLoss).toBe(0);
    expect(result.action?.estimatedTax).toBe(0);
  });

  it("needs no operation once the accounts hold the target", async () => {
    holdingRows = [
      {
        security_id: "sec-emim",
        symbol: "EMIM",
        name: "EM IMI ETF",
        quantity: "700",
        cost_basis: "21000",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    priceService.latestPrices.mockResolvedValue(new Map([["sec-emim", 35]]));

    const result = await build();
    expect(result.position?.exactTargetPercent).toBe(100);
    expect(result.action?.required).toBe(false);
    expect(result.action?.sellPositions).toEqual([]);
  });

  describe("cash in the strategy accounts", () => {
    /** The target, held in full, plus an equal amount of idle cash. */
    const targetPlusCash = () => {
      holdingRows = [
        {
          security_id: "sec-emim",
          symbol: "EMIM",
          name: "EM IMI ETF",
          quantity: "200",
          cost_basis: "4000",
          currency_code: "USD",
          account_ids: ["acct-1"],
        },
      ];
      cashRows = [
        {
          owner_account_id: "acct-1",
          current_balance: "5000",
          currency_code: "USD",
        },
      ];
      priceService.latestPrices.mockResolvedValue(new Map([["sec-emim", 25]]));
    };

    it("counts idle cash as off target rather than as compliance", async () => {
      // The regression: reading only `holdings` reported this account 100%
      // compliant with nothing to do, while half of it was uninvested.
      targetPlusCash();

      const result = await build();

      expect(result.position?.totalMarketValue).toBe(10000);
      // Every security held is the target, and the exact-allocation figure is
      // about the securities -- but half the account is uninvested, which is
      // still a change: the cash has to be put to work.
      expect(result.position?.exactTargetPercent).toBe(100);
      expect(result.position?.changeRequired).toBe(true);
      expect(result.action?.required).toBe(true);
      // Nothing is sold; the purchase is funded by the cash.
      expect(result.action?.sellPositions).toEqual([]);
      expect(result.action?.transferValue).toBe(5000);
    });

    it("shows cash as a position with no instrument and no quantity", async () => {
      targetPlusCash();

      const result = await build();
      const cash = result.position?.holdings.find((held) => held.isCash);

      expect(cash).toMatchObject({
        securityId: null,
        symbol: null,
        quantity: null,
        marketValue: 5000,
        matchPercent: 0,
        // There is no breakdown that would make cash match a market, so this
        // is not the "fill in the data" case the ticker fallback reports.
        matchedByInstrument: false,
      });
    });

    it("spends cash rather than selling it, so it costs no commission", async () => {
      targetPlusCash();

      const result = await build();

      // One trade: the buy. Cash is not a position anyone sells.
      expect(result.action?.estimatedTradeCount).toBe(1);
      expect(result.action?.estimatedCommission).toBe(29.9);
      // And it realizes nothing, so there is no tax on putting it to work.
      expect(result.action?.realizedGainLoss).toBe(0);
      expect(result.action?.estimatedTax).toBe(0);
    });

    it("never names cash as the position to sell out of", async () => {
      // Cash can easily be the largest thing in the account, and "sell out of
      // Cash" is an instruction nobody can carry out. The switch here is a
      // pure purchase: there is nothing to sell.
      holdingRows = [];
      cashRows = [
        {
          owner_account_id: "acct-1",
          current_balance: "5000",
          currency_code: "USD",
        },
      ];

      const result = await build();

      expect(result.action?.required).toBe(true);
      expect(result.action?.transferValue).toBe(5000);
      expect(result.action?.sellPositions).toEqual([]);
      expect(result.action?.estimatedTradeCount).toBe(1);
    });

    it("names the largest sellable holding, not the larger cash balance", async () => {
      holdingRows = [
        {
          security_id: "sec-spy",
          symbol: "SPY",
          name: "S&P 500 ETF",
          quantity: "10",
          cost_basis: "3000",
          currency_code: "USD",
          account_ids: ["acct-1"],
        },
      ];
      cashRows = [
        {
          owner_account_id: "acct-1",
          current_balance: "9000",
          currency_code: "USD",
        },
      ];
      priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 400]]));
      portfolioCalculation.calculateCostBasesInAccountCurrency.mockResolvedValue(
        new Map([["acct-1:sec-spy", 3000]]),
      );

      const result = await build();

      // Cash is the bigger position and still not what gets sold.
      expect(result.position?.current?.isCash).toBe(true);
      expect(result.action?.sellPositions.map((held) => held.symbol)).toEqual([
        "SPY",
      ]);
      // Both move, though: 9000 of cash plus the whole 4000 of SPY.
      expect(result.action?.transferValue).toBe(13000);
      // And only the sale realizes anything.
      expect(result.action?.realizedGainLoss).toBe(1000);
    });

    it("ignores a negative balance, which is a debt and not a position", async () => {
      // Filtered in SQL: a margin debit is money owed, and treating it as
      // off-target value would inflate the purchase by the size of the loan.
      targetPlusCash();
      cashRows = [];

      const result = await build();

      expect(result.position?.holdings.some((held) => held.isCash)).toBe(false);
      expect(result.position?.exactTargetPercent).toBe(100);
    });

    it("asks for the linked cash account of every strategy account", async () => {
      await build();
      const cashCall = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("current_balance"),
      );
      expect(cashCall?.[0]).toContain("INVESTMENT_CASH");
      expect(cashCall?.[0]).toContain("linked_account_id");
      expect(cashCall?.[1]).toEqual([["acct-1", "acct-2"], userId]);
    });
  });

  it("does not require an operation without a target instrument", async () => {
    const result = await build({ targetRole: null });
    expect(result.position?.target).toBeNull();
    expect(result.action?.required).toBe(false);
  });

  it("still reports a portfolio made only of non-strategy instruments", async () => {
    holdingRows = [
      {
        security_id: "sec-unrelated",
        symbol: "FZD2050",
        name: "A fund the strategy does not use",
        quantity: "5",
        cost_basis: "100",
        currency_code: "USD",
        account_ids: ["acct-1"],
      },
    ];
    const result = await build();
    // There is a position -- just none of it where the strategy wants it.
    expect(result.noPosition).toBe(false);
    expect(result.position?.holdings[0].symbol).toBe("FZD2050");
    // Nothing here can be priced, so neither the share nor the largest
    // position can be stated -- but holding something other than the target
    // still calls for a switch.
    expect(result.position?.current).toBeNull();
    expect(result.position?.exactTargetPercent).toBeNull();
    expect(result.action?.required).toBe(true);
  });
});
