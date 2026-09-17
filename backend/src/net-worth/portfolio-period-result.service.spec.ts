import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
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
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let scopeRows: FakeRow[];
  let flowRows: FakeRow[];
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
        if (sql.includes("SUM(t.amount)")) return flowRows;
        if (sql.includes("it.funding_account_id")) return settledTradeRows;
        if (sql.includes("COUNT(*) AS count")) return mixedSplitRows;
        if (sql.includes("FROM exchange_rates")) return rateRows;
        if (sql.includes("FROM accounts")) return scopeRows;
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    netWorth = { getDailyInvestments: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioPeriodResultService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
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
    } = {},
  ) => ({
    date,
    value,
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
    );
  });
});
