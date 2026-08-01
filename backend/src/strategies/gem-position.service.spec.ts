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

  beforeEach(() => {
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    manager.query.mockResolvedValue([
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "51",
        cost_basis: "18281.46",
        currency_code: "USD",
      },
    ]);
    priceService = {
      latestPrices: jest
        .fn()
        .mockResolvedValue(new Map([["sec-spy", 452.475]])),
    };
    exchangeRates = { getLatestRate: jest.fn().mockResolvedValue(null) };
    service = new GemPositionService(
      mocks.dataSource as never,
      priceService as never,
      exchangeRates as never,
    );
  });

  it("describes the held position and the operation the signal requires", async () => {
    const result = await build();

    expect(result.position).toMatchObject({
      accounts,
      compliancePercent: 0,
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
    manager.query.mockResolvedValue([
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: "3000",
        currency_code: "USD",
      },
      {
        security_id: "sec-wtai",
        symbol: "WTAI",
        name: "AI ETF",
        quantity: "100",
        cost_basis: "5000",
        currency_code: "USD",
      },
    ]);
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
    expect(result.position?.compliancePercent).toBe(0);
    expect(result.position?.holdings.map((h) => h.symbol)).toEqual([
      "WTAI",
      "SPY",
    ]);
    expect(result.position?.holdings[0].role).toBeNull();
    expect(result.action?.transferValue).toBe(10000);
    expect(result.action?.fromCount).toBe(2);
    expect(result.action?.from?.symbol).toBe("WTAI");
  });

  it("sells out of the off-target holding, not the largest one", async () => {
    manager.query.mockResolvedValue([
      {
        security_id: "sec-emim",
        symbol: "EMIM",
        name: "EM IMI ETF",
        quantity: "200",
        cost_basis: "6000",
        currency_code: "USD",
      },
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "5",
        cost_basis: "1500",
        currency_code: "USD",
      },
    ]);
    priceService.latestPrices.mockResolvedValue(
      new Map([
        ["sec-emim", 35],
        ["sec-spy", 400],
      ]),
    );

    const result = await build();

    // EMIM is the target and the larger position, so the switch sells SPY.
    expect(result.position?.current?.symbol).toBe("EMIM");
    expect(result.action?.from?.symbol).toBe("SPY");
    expect(result.action?.fromCount).toBe(1);
    expect(result.action?.transferValue).toBe(2000);
  });

  it("leaves the cost basis unknown when one account is uncosted", async () => {
    // The aggregate query returns NULL for the whole security when any of the
    // summed holdings has no average cost -- an understated basis would inflate
    // the realized result and the tax on it.
    manager.query.mockResolvedValue([
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "51",
        cost_basis: null,
        currency_code: "USD",
      },
    ]);

    const result = await build();

    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain("bool_or(h.average_cost IS NULL)");
    expect(result.action?.transferValue).toBeCloseTo(23076.225, 3);
    expect(result.action?.realizedGainLoss).toBeNull();
    expect(result.action?.estimatedTax).toBeNull();
  });

  it("converts a foreign-currency holding into the report currency", async () => {
    manager.query.mockResolvedValue([
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: "1000",
        currency_code: "EUR",
      },
    ]);
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 200]]));
    exchangeRates.getLatestRate.mockResolvedValue(1.1);

    const result = await build();

    expect(exchangeRates.getLatestRate).toHaveBeenCalledWith("EUR", "USD");
    expect(result.position?.current?.marketValue).toBeCloseTo(2200, 2);
    // 2200 market value against a 1100 cost basis, both converted.
    expect(result.action?.realizedGainLoss).toBeCloseTo(1100, 2);
  });

  it("falls back to the inverse rate, then to parity", async () => {
    manager.query.mockResolvedValue([
      {
        security_id: "sec-spy",
        symbol: "SPY",
        name: "S&P 500 ETF",
        quantity: "10",
        cost_basis: null,
        currency_code: "EUR",
      },
    ]);
    priceService.latestPrices.mockResolvedValue(new Map([["sec-spy", 100]]));
    exchangeRates.getLatestRate
      .mockResolvedValueOnce(null) // EUR -> USD unknown
      .mockResolvedValueOnce(0.5); // USD -> EUR known
    let result = await build();
    expect(result.position?.current?.marketValue).toBeCloseTo(2000, 2);

    exchangeRates.getLatestRate.mockResolvedValue(null);
    result = await build();
    expect(result.position?.current?.marketValue).toBeCloseTo(1000, 2);
  });

  it("returns nothing when the strategy has no accounts", async () => {
    const result = await build({ accounts: [] });
    expect(result).toEqual({ position: null, action: null, noPosition: false });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("reports empty strategy accounts as having no position", async () => {
    manager.query.mockResolvedValue([]);
    const result = await build();
    expect(result.noPosition).toBe(true);
    expect(result.position?.current).toBeNull();
    expect(result.action?.required).toBe(true);
    expect(result.action?.transferValue).toBeNull();
  });

  it("needs no operation once the accounts hold the target", async () => {
    manager.query.mockResolvedValue([
      {
        security_id: "sec-emim",
        symbol: "EMIM",
        name: "EM IMI ETF",
        quantity: "700",
        cost_basis: "21000",
        currency_code: "USD",
      },
    ]);
    priceService.latestPrices.mockResolvedValue(new Map([["sec-emim", 35]]));

    const result = await build();
    expect(result.position?.compliancePercent).toBe(100);
    expect(result.action?.required).toBe(false);
  });

  it("does not require an operation without a target instrument", async () => {
    const result = await build({ targetRole: null });
    expect(result.position?.target).toBeNull();
    expect(result.action?.required).toBe(false);
  });

  it("still reports a portfolio made only of non-strategy instruments", async () => {
    manager.query.mockResolvedValue([
      {
        security_id: "sec-unrelated",
        symbol: "FZD2050",
        name: "A fund the strategy does not use",
        quantity: "5",
        cost_basis: "100",
        currency_code: "USD",
      },
    ]);
    const result = await build();
    // There is a position -- just none of it where the strategy wants it.
    expect(result.noPosition).toBe(false);
    expect(result.position?.current?.symbol).toBe("FZD2050");
    // Nothing here can be priced, so the share is unknown rather than zero --
    // but holding something other than the target still calls for a switch.
    expect(result.position?.compliancePercent).toBeNull();
    expect(result.action?.required).toBe(true);
  });
});
