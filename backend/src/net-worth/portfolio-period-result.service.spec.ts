import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService } from "./net-worth.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

interface FakeRow {
  [key: string]: unknown;
}

/**
 * The fixture is the issue's reproduction (#1392): a security at 100 that never
 * moves, a 10,000 deposit and a 100-unit buy on 2026-01-02, the same again on
 * 2026-06-01. The value series therefore runs 10,000 -> 20,000 with nothing
 * having been earned.
 */
describe("PortfolioPeriodResultService", () => {
  let service: PortfolioPeriodResultService;
  let netWorth: { getDailyInvestments: jest.Mock };
  let exchangeRates: { ensureRatesForDate: jest.Mock };
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let scopeRows: FakeRow[];
  let flowRows: FakeRow[];
  let investedRows: FakeRow[];
  let rateRows: FakeRow[];
  let settledTradeRows: FakeRow[];
  let mixedSplitRows: FakeRow[];
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(async () => {
    queries = [];
    // The brokerage holds the positions; only the cash sleeve's ledger cash is
    // valued, which is what the flow boundary is drawn around.
    scopeRows = [
      {
        id: "brok-1",
        account_type: "INVESTMENT",
        account_sub_type: "INVESTMENT_BROKERAGE",
      },
      {
        id: "cash-1",
        account_type: "INVESTMENT",
        account_sub_type: "INVESTMENT_CASH",
      },
    ];
    flowRows = [];
    investedRows = [];
    rateRows = [];
    settledTradeRows = [{ count: "0" }];
    mixedSplitRows = [{ count: "0" }];

    const preferenceRepo = {
      findOne: jest.fn(async () => ({ defaultCurrency: "CAD" })),
    };
    mocks = createScopedDbMocks([[UserPreference, preferenceRepo]]);
    mocks.manager.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        // Three statements name `investment_transactions` (the flow query and
        // the mixed-split count do so inside their exclusions), so each is
        // matched on a fragment only it carries.
        if (sql.includes("it.action AS action")) return investedRows;
        if (sql.includes("SUM(t.amount)")) return flowRows;
        if (sql.includes("it.funding_account_id")) return settledTradeRows;
        if (sql.includes("COUNT(*) AS count")) return mixedSplitRows;
        if (sql.includes("FROM exchange_rates")) return rateRows;
        if (sql.includes("FROM accounts")) return scopeRows;
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    netWorth = { getDailyInvestments: jest.fn().mockResolvedValue([]) };
    exchangeRates = { ensureRatesForDate: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioPeriodResultService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
        { provide: ExchangeRateService, useValue: exchangeRates },
      ],
    }).compile();

    service = module.get(PortfolioPeriodResultService);
  });

  afterEach(() => jest.restoreAllMocks());

  const point = (
    date: string,
    value: number,
    flags: {
      fxComplete?: boolean;
      pricesComplete?: boolean;
      cashComplete?: boolean;
      unpricedSecurityIds?: string[];
      unknownCashAccountIds?: string[];
      securitiesValue?: number;
    } = {},
  ) => ({
    date,
    value,
    // Cash-free unless a case says otherwise: the invested part IS the value.
    securitiesValue: flags.securitiesValue ?? value,
    fxComplete: flags.fxComplete ?? true,
    missingRatePairs: [],
    pricesComplete: flags.pricesComplete ?? true,
    unpricedSecurityIds: flags.unpricedSecurityIds ?? [],
    cashComplete: flags.cashComplete ?? true,
    unknownCashAccountIds: flags.unknownCashAccountIds ?? [],
  });

  const flatSeries = () => [
    point("2026-01-02", 10_000),
    point("2026-06-01", 20_000),
    point("2026-09-17", 20_000),
  ];

  const run = (overrides: Record<string, unknown> = {}) =>
    service.getPeriodResult("user-1", {
      startDate: "2026-01-02",
      endDate: "2026-09-17",
      ...overrides,
    });

  it("reports the deposit as a flow, so the result is zero", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];

    const result = await run();

    expect(result).toMatchObject({
      currency: "CAD",
      startDate: "2026-01-02",
      endDate: "2026-09-17",
      valueChange: 10_000,
      netExternalFlows: 10_000,
      investmentResult: 0,
      returnPercent: 0,
      returnMethod: "simple",
      complete: true,
      reasons: [],
    });
  });

  /**
   * The whole defect, in one assertion: the figure the report used to print.
   * A `last - first` change over the same series says +10,000, which is the
   * deposit, and +100%, which is nothing that happened.
   */
  it("does not report the value change as the return", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];

    const result = await run();

    expect(result.valueChange).toBe(10_000);
    expect(result.investmentResult).not.toBe(result.valueChange);
    expect(result.returnPercent).not.toBe(100);
  });

  /**
   * The second reading of the same caption (spec section 10). "Portfolio
   * performance" must answer what the INVESTMENTS did, so cash the reader pays
   * in cannot move it -- not the amount, and not the percentage.
   *
   * The series is the same three closes, but with the invested part named: the
   * portfolio holds 8,000 of securities that gain 10% to 8,800, and on
   * 2026-09-16 a 50,000 deposit lands and is left as cash. The ACCOUNT-level
   * value change moves by that 50,000; the invested figures do not move at all.
   */
  it("keeps a late cash deposit out of the invested figures", async () => {
    const invested = [
      point("2026-01-02", 10_000, { securitiesValue: 8_000 }),
      point("2026-06-01", 10_800, { securitiesValue: 8_800 }),
      point("2026-09-17", 60_800, { securitiesValue: 8_800 }),
    ];
    netWorth.getDailyInvestments.mockResolvedValue(invested);
    flowRows = [{ date: "2026-09-16", currency: "CAD", total: "50000" }];

    const result = await run();

    // The account-level measure sees the deposit and subtracts it.
    expect(result.valueChange).toBe(50_800);
    expect(result.netExternalFlows).toBe(50_000);

    // The invested measure never saw it: 8,800 - 8,000 with no capital flow.
    expect(result.investmentPnl).toBe(800);
    // +10% on the securities, not +8% on securities-plus-cash, and not a
    // fraction of a base the 50,000 joined.
    expect(result.investmentReturnPercent).toBe(10);
    expect(result.investmentReturnMethod).toBe("twr");
    expect(result.investedComplete).toBe(true);
  });

  it("reports the same invested figures without the late deposit", async () => {
    // The control for the case above: removing the deposit changes the
    // account-level figures and leaves the invested ones identical.
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-01-02", 10_000, { securitiesValue: 8_000 }),
      point("2026-06-01", 10_800, { securitiesValue: 8_800 }),
      point("2026-09-17", 10_800, { securitiesValue: 8_800 }),
    ]);

    const result = await run();

    expect(result.valueChange).toBe(800);
    expect(result.investmentPnl).toBe(800);
    expect(result.investmentReturnPercent).toBe(10);
  });

  it("counts a buy as capital and a dividend as income", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-01-02", 10_000, { securitiesValue: 0 }),
      point("2026-06-01", 10_000, { securitiesValue: 8_000 }),
      point("2026-09-17", 10_100, { securitiesValue: 8_000 }),
    ]);
    investedRows = [
      {
        date: "2026-06-01",
        currency: "CAD",
        action: "BUY",
        total: "8000",
        gross: "8000",
      },
      {
        date: "2026-09-17",
        currency: "CAD",
        action: "DIVIDEND",
        total: "100",
        gross: "100",
      },
    ];

    const result = await run();

    expect(result.investmentCapitalFlows).toBe(8_000);
    expect(result.investmentIncome).toBe(100);
    // The purchase is not a gain; the distribution is, although it ends as cash.
    expect(result.investmentPnl).toBe(100);
    expect(result.investmentReturnPercent).toBe(1.25);
  });

  it("counts no flow dated on the baseline day", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    await run();

    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    // $2 is the exclusive lower bound: the baseline's own close already holds
    // the deposit that landed on it.
    expect(flowQuery.params[1]).toBe("2026-01-02");
    expect(flowQuery.params[2]).toBe("2026-09-17");
  });

  it("measures from an explicit baseline and counts the flows after it", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-09-16", 19_000),
      point("2026-09-17", 20_000),
    ]);

    const result = await run({
      startDate: "2026-09-17",
      baselineDate: "2026-09-16",
    });

    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-09-16",
      "2026-09-17",
      undefined,
      "CAD",
      { fetchMissing: undefined },
    );
    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    expect(flowQuery.params[1]).toBe("2026-09-16");
    expect(result.startDate).toBe("2026-09-16");
    expect(result.valueChange).toBe(1_000);
    expect(result.investmentResult).toBe(1_000);
  });

  it("converts a foreign flow at the rate of its own day", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [{ date: "2026-06-01", currency: "USD", total: "5000" }];
    rateRows = [
      {
        from_currency: "USD",
        to_currency: "CAD",
        rate: "1.2",
        rate_date: "2026-06-01",
      },
      // A later observation must not price an earlier day (no look-ahead).
      {
        from_currency: "USD",
        to_currency: "CAD",
        rate: "2",
        rate_date: "2026-09-01",
      },
    ];

    const result = await run();

    expect(result.netExternalFlows).toBe(6_000);
    expect(result.investmentResult).toBe(4_000);
  });

  it("withholds the flow and the result when a flow day has no rate", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [
      { date: "2026-06-01", currency: "CAD", total: "4000" },
      { date: "2026-06-01", currency: "EUR", total: "5000" },
    ];

    const result = await run();

    expect(result.netExternalFlows).toBeNull();
    expect(result.investmentResult).toBeNull();
    expect(result.returnPercent).toBeNull();
    expect(result.knownFlowSubtotal).toBe(4_000);
    expect(result.missingRatePairs).toEqual(["EUR->CAD"]);
    expect(result.reasons).toEqual(["missingRatePairs"]);
  });

  it("withholds the value change when a boundary day is a subtotal", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-01-02", 10_000, {
        pricesComplete: false,
        unpricedSecurityIds: ["sec-1"],
      }),
      point("2026-09-17", 20_000),
    ]);
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];

    const result = await run();

    expect(result.valueChange).toBeNull();
    expect(result.investmentResult).toBeNull();
    expect(result.reasons).toEqual(["incompletePrices"]);
    expect(result.unpricedSecurityIds).toEqual(["sec-1"]);
    expect(result.netExternalFlows).toBe(10_000);
  });

  /**
   * The audit's case (#1389, F1): a 10,000 BUY settled from a chequing account.
   * The purchase raises the market value by 10,000 and leaves no cash leg in
   * the scope, so the flow query sees nothing and a subtraction of the two
   * reports the reader's own money as a hundred per cent gain -- the #1392
   * defect reached by a second route.
   */
  it("withholds the result when a trade settled outside the valued cash", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    settledTradeRows = [{ count: "1" }];

    const result = await run();

    expect(result.investmentResult).toBeNull();
    expect(result.returnPercent).toBeNull();
    expect(result.reasons).toEqual(["externallySettledTrade"]);
    // The two measured figures still stand; only their difference is unknown.
    expect(result.valueChange).toBe(10_000);
    expect(result.netExternalFlows).toBe(0);
  });

  it("asks about trades on the whole scope, settled against the valued cash", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    await run();

    const settled = queries.find((q) =>
      q.sql.includes("it.funding_account_id"),
    )!;
    expect(settled.params[1]).toBe("2026-01-02");
    expect(settled.params[2]).toBe("2026-09-17");
    expect(settled.params[3]).toEqual(["brok-1", "cash-1"]);
    expect(settled.params[4]).toEqual(["cash-1"]);
  });

  /**
   * The flow sum drops a mixed split parent WHOLE (`external-flow.util.ts`), so
   * its ordinary cash line is in the value change with nothing to subtract it.
   */
  it("withholds the result when a split parent mixes investment and cash lines", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    mixedSplitRows = [{ count: "2" }];

    const result = await run();

    expect(result.investmentResult).toBeNull();
    expect(result.reasons).toEqual(["mixedSplit"]);
    expect(result.valueChange).toBe(10_000);
  });

  it("reports nothing for a scope with no accounts", async () => {
    scopeRows = [];

    const result = await run();

    expect(result.reasons).toEqual(["noValueSeries"]);
    expect(result.valueChange).toBeNull();
    expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
  });

  it("reports nothing when the scope produced no valued day", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([]);

    const result = await run();

    expect(result.reasons).toEqual(["noValueSeries"]);
    expect(result.startDate).toBe("2026-01-02");
  });

  it("draws the flow boundary around the accounts whose cash is valued", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    await run({ accountIds: ["brok-1"] });

    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    // The brokerage row's own ledger cash is NOT in the series, so a row posted
    // to it is not a flow of this period either: one boundary, or a deposit
    // there is subtracted from a value change that never held it.
    expect(flowQuery.params[3]).toEqual(["cash-1"]);
    // The series is asked with the ids the caller gave: getDailyInvestments
    // does the same widening itself, and doing it twice is a no-op.
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-01-02",
      "2026-09-17",
      ["brok-1"],
      "CAD",
      { fetchMissing: undefined },
    );
  });

  it("honours an explicit display currency over the preference", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    const result = await run({ displayCurrency: "USD" });

    expect(result.currency).toBe("USD");
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-01-02",
      "2026-09-17",
      undefined,
      "USD",
      { fetchMissing: undefined },
    );
  });

  describe("read-path FX fill", () => {
    // A EUR deposit into a CAD-reported portfolio, over a window the
    // exchange_rates table has no row for: the flow is the component that
    // cannot convert, so it is the flow fold that asks the provider (#1390).
    const eurFlow = () => {
      netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
      flowRows = [{ date: "2026-06-01", currency: "EUR", total: "10000" }];
    };

    it("asks the provider for the month the flow could not convert", async () => {
      eurFlow();

      const result = await run();

      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledTimes(1);
      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "EUR", to: "CAD" }],
        "2026-06-01",
      );
      // Nothing was stored, so the pair stays missing and the figure withheld.
      expect(result.netExternalFlows).toBeNull();
      expect(result.missingRatePairs).toContain("EUR->CAD");
    });

    it("re-reads the rates and completes the flow when the fill stored rows", async () => {
      eurFlow();
      exchangeRates.ensureRatesForDate.mockImplementation(async () => {
        rateRows = [
          {
            from_currency: "EUR",
            to_currency: "CAD",
            rate: "1.5",
            rate_date: "2026-06-01",
          },
        ];
        return 20;
      });

      const result = await run();

      expect(result.netExternalFlows).toBe(15_000);
      expect(result.missingRatePairs).toEqual([]);
    });

    it("makes no provider call, on either half, when the caller opted out", async () => {
      eurFlow();

      const result = await run({ fetchMissing: false });

      expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2026-01-02",
        "2026-09-17",
        undefined,
        "CAD",
        { fetchMissing: false },
      );
      expect(result.netExternalFlows).toBeNull();
    });

    it("answers the period when the provider throws", async () => {
      eurFlow();
      exchangeRates.ensureRatesForDate.mockRejectedValue(
        new Error("provider unreachable"),
      );

      const result = await run();

      expect(result.netExternalFlows).toBeNull();
      expect(result.missingRatePairs).toContain("EUR->CAD");
    });
  });
});
