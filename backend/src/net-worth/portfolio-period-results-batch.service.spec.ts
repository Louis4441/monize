import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { addDaysYMD } from "../common/date-utils";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NetWorthService } from "./net-worth.service";
import {
  PORTFOLIO_PERIOD_PRESETS,
  PortfolioPeriodPreset,
  presetWindowStart,
  usesPriorCloseBaseline,
} from "./portfolio-period-presets.util";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";
import { PortfolioPeriodResultsBatchService } from "./portfolio-period-results-batch.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

const TODAY = "2026-09-17";

interface FakeRow {
  [key: string]: unknown;
}

interface SeriesPoint {
  date: string;
  value: number;
  fxComplete: boolean;
  missingRatePairs: string[];
  pricesComplete: boolean;
  unpricedSecurityIds: string[];
  cashComplete: boolean;
  unknownCashAccountIds: string[];
}

function point(date: string, value: number): SeriesPoint {
  return {
    date,
    value,
    fxComplete: true,
    missingRatePairs: [],
    pricesComplete: true,
    unpricedSecurityIds: [],
    cashComplete: true,
    unknownCashAccountIds: [],
  };
}

/**
 * A full year of daily closes ending today: flat at 10,000 until a 10,000
 * deposit on 2026-06-01 doubles it, then one real gain of 200 on the last day.
 *
 * The deposit is deliberately inside the YTD and 1Y windows and outside the 3M
 * one (which opens on 2026-06-19), so a preset that took the wrong slice of the
 * flows would report the reader's own money as a gain in one window or lose a
 * real one in another.
 */
function canonicalSeries(from = "2025-09-17", to = TODAY): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (let date = from; date <= to; date = addDaysYMD(date, 1)) {
    const value =
      date === TODAY ? 20_200 : date >= "2026-06-01" ? 20_000 : 10_000;
    points.push(point(date, value));
  }
  return points;
}

describe("PortfolioPeriodResultsBatchService", () => {
  let batch: PortfolioPeriodResultsBatchService;
  let single: PortfolioPeriodResultService;
  let netWorth: { getDailyInvestments: jest.Mock };
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let scopeRows: FakeRow[];
  let flowRows: Array<{ date: string; currency: string; total: string }>;
  let rateRows: FakeRow[];
  let settledTradeDays: Array<{ date: string; count: string }>;
  let mixedSplitDays: Array<{ date: string; count: string }>;
  let series: SeriesPoint[];
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(async () => {
    queries = [];
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
    series = canonicalSeries();
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];
    rateRows = [];
    settledTradeDays = [];
    mixedSplitDays = [];

    const preferenceRepo = {
      findOne: jest.fn(async () => ({ defaultCurrency: "CAD" })),
    };
    mocks = createScopedDbMocks([[UserPreference, preferenceRepo]]);
    // Every loader is answered the way the database would answer it: the rows
    // in the window the statement asked for, per day where it asked per day.
    // Slicing is the whole claim under test, so a mock that ignored the bounds
    // would make the batch and the single route agree by construction.
    mocks.manager.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        const after = params[1] as string;
        const through = params[2] as string;
        const inWindow = (date: string) => date > after && date <= through;
        const perDay = sql.includes("TO_CHAR");
        const counts = (days: Array<{ date: string; count: string }>) => {
          const rows = days.filter((day) => inWindow(day.date));
          if (perDay) return rows;
          const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
          return [{ date: null, count: String(total) }];
        };
        if (sql.includes("SUM(t.amount)"))
          return flowRows.filter((row) => inWindow(row.date));
        if (sql.includes("it.funding_account_id"))
          return counts(settledTradeDays);
        if (sql.includes("COUNT(*) AS count")) return counts(mixedSplitDays);
        if (sql.includes("FROM exchange_rates")) return rateRows;
        if (sql.includes("FROM accounts")) return scopeRows;
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    netWorth = {
      getDailyInvestments: jest.fn(
        async (_userId: string, from: string, to: string) =>
          series.filter((p) => p.date >= from && p.date <= to),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioPeriodResultService,
        PortfolioPeriodResultsBatchService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
      ],
    }).compile();

    batch = module.get(PortfolioPeriodResultsBatchService);
    single = module.get(PortfolioPeriodResultService);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * What the client used to send for one preset: the window's start, plus the
   * close before the window's first point where the preset reports against the
   * prior close (`usesPriorCloseBaseline`, `previousCalendarDay`).
   */
  const singleRouteArgs = (preset: PortfolioPeriodPreset) => {
    const startDate = presetWindowStart(preset, TODAY);
    const firstPoint = series.find((p) => p.date >= startDate);
    const baselineDate =
      usesPriorCloseBaseline(preset) && firstPoint
        ? addDaysYMD(firstPoint.date, -1)
        : undefined;
    return { startDate, endDate: TODAY, baselineDate };
  };

  it("answers every preset with what the single-range route answers", async () => {
    const results = await batch.getPeriodResults("user-1");

    for (const preset of PORTFOLIO_PERIOD_PRESETS) {
      const expected = await single.getPeriodResult(
        "user-1",
        singleRouteArgs(preset),
      );
      expect(results.periods[preset]).toEqual(expected);
    }
  });

  it("builds the value series once, over the widest window asked for", async () => {
    await batch.getPeriodResults("user-1");

    expect(netWorth.getDailyInvestments).toHaveBeenCalledTimes(1);
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      // 1Y opens on 2025-09-17; nothing reaches further back.
      "2025-09-17",
      TODAY,
      undefined,
      "CAD",
    );
  });

  it("loads only what the presets asked for need", async () => {
    await batch.getPeriodResults("user-1", { periods: ["1d", "1w"] });

    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      // A prior-close preset reaches one day further back than its window.
      "2026-09-09",
      TODAY,
      undefined,
      "CAD",
    );
    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    expect(flowQuery.params[1]).toBe("2026-09-09");
  });

  it("measures a day against the previous close", async () => {
    const results = await batch.getPeriodResults("user-1", { periods: ["1d"] });

    expect(results.periods["1d"]).toMatchObject({
      startDate: "2026-09-16",
      endDate: TODAY,
      startValue: 20_000,
      endValue: 20_200,
      valueChange: 200,
      netExternalFlows: 0,
      investmentResult: 200,
      returnPercent: 1,
      complete: true,
      reasons: [],
    });
  });

  /**
   * The issue's defect, sliced: the 10,000 deposit of 2026-06-01 is inside YTD
   * and outside 3M. A window that counted it as performance would report a 3M
   * gain of 10,200 and a YTD return of 102%; only the last day's 200 was earned.
   */
  it("counts a flow in the windows that contain it, and in no others", async () => {
    const results = await batch.getPeriodResults("user-1");

    expect(results.periods.ytd).toMatchObject({
      valueChange: 10_200,
      netExternalFlows: 10_000,
      investmentResult: 200,
      returnPercent: 2,
    });
    expect(results.periods["3m"]).toMatchObject({
      valueChange: 200,
      netExternalFlows: 0,
      investmentResult: 200,
      returnPercent: 1,
    });
  });

  it("withholds a window that holds an uncountable movement, and no other", async () => {
    settledTradeDays = [{ date: "2026-06-02", count: "1" }];

    const results = await batch.getPeriodResults("user-1");

    expect(results.periods["1y"]).toMatchObject({
      investmentResult: null,
      returnPercent: null,
      reasons: ["externallySettledTrade"],
      valueChange: 10_200,
    });
    // The trade is outside the 1M window, which stays measurable.
    expect(results.periods["1m"]).toMatchObject({
      investmentResult: 200,
      reasons: [],
    });
  });

  it("says nothing for a period the history does not reach back to", async () => {
    series = canonicalSeries("2026-09-15");

    const results = await batch.getPeriodResults("user-1");

    // Three days of history: the day is measurable, the year is not, and the
    // year is not measured from the first day the portfolio existed.
    expect(results.periods["1d"]?.investmentResult).toBe(200);
    expect(results.periods["1y"]).toMatchObject({
      startDate: "2025-09-17",
      valueChange: null,
      investmentResult: null,
      returnPercent: null,
      reasons: ["noValueSeries"],
    });
  });

  it("reports in the currency it was asked for", async () => {
    const results = await batch.getPeriodResults("user-1", {
      displayCurrency: "USD",
      periods: ["1m"],
    });

    expect(results.currency).toBe("USD");
    expect(results.periods["1m"]?.currency).toBe("USD");
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-08-18",
      TODAY,
      undefined,
      "USD",
    );
  });

  it("answers every preset for a scope with no accounts, and values none", async () => {
    scopeRows = [];

    const results = await batch.getPeriodResults("user-1");

    expect(Object.keys(results.periods).sort()).toEqual(
      [...PORTFOLIO_PERIOD_PRESETS].sort(),
    );
    for (const preset of PORTFOLIO_PERIOD_PRESETS) {
      expect(results.periods[preset]).toMatchObject({
        valueChange: null,
        investmentResult: null,
        reasons: ["noValueSeries"],
      });
    }
    expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
  });

  it("names the day every period is measured to", async () => {
    const results = await batch.getPeriodResults("user-1", { periods: ["1m"] });

    expect(results.asOf).toBe(TODAY);
    expect(results.periods["1m"]?.endDate).toBe(TODAY);
    expect(results.periods["3m"]).toBeUndefined();
  });
});
