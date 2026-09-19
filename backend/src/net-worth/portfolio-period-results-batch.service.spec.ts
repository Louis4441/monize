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
import { ExchangeRateService } from "../currencies/exchange-rate.service";

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
  securitiesValue: number;
  fxComplete: boolean;
  missingRatePairs: string[];
  pricesComplete: boolean;
  unpricedSecurityIds: string[];
  cashComplete: boolean;
  unknownCashAccountIds: string[];
}

/** The scope holds a flat 2,000 of uninvested cash on every day of the series. */
const SERIES_CASH = 2_000;

function point(date: string, value: number): SeriesPoint {
  return {
    date,
    value,
    securitiesValue: value - SERIES_CASH,
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
  let exchangeRates: { ensureRatesForDate: jest.Mock };
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let scopeRows: FakeRow[];
  let flowRows: Array<{ date: string; currency: string; total: string }>;
  let investedRows: Array<{
    date: string;
    currency: string;
    action: string;
    total: string;
    gross: string;
  }>;
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
    // The deposit of 2026-06-01 is invested the same day, so the invested part
    // grows by a capital flow rather than by a gain: the day contributes factor
    // 1 to every preset whose window holds it.
    investedRows = [
      {
        date: "2026-06-01",
        currency: "CAD",
        action: "BUY",
        total: "10000",
        gross: "10000",
      },
    ];
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
        if (sql.includes("it.action AS action"))
          return investedRows.filter((row) => inWindow(row.date));
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

    exchangeRates = { ensureRatesForDate: jest.fn(async () => 0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioPeriodResultService,
        PortfolioPeriodResultsBatchService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
        { provide: ExchangeRateService, useValue: exchangeRates },
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

  it("answers every preset with the same money-weighted figures as the single route", async () => {
    // The MWR is a second figure of one measure, sliced from the same series
    // and the same per-day flows, so the two routes cannot disagree about it
    // any more than they may about the TWR (spec section 11.8).
    const results = await batch.getPeriodResults("user-1");

    for (const preset of PORTFOLIO_PERIOD_PRESETS) {
      const expected = await single.getPeriodResult(
        "user-1",
        singleRouteArgs(preset),
      );
      expect(results.periods[preset]).toMatchObject({
        investmentMoneyWeightedReturnPercent:
          expected.investmentMoneyWeightedReturnPercent,
        investmentMoneyWeightedTotalPercent:
          expected.investmentMoneyWeightedTotalPercent,
        investmentMoneyWeightedMethod: "xirr",
      });
    }
    // Not a vacuous comparison of two nulls: the year-to-date window is long
    // enough to annualise and carries a rate.
    expect(results.periods.ytd?.investmentMoneyWeightedReturnPercent).toEqual(
      expect.any(Number),
    );
    // A week is not long enough to annualise, and says so rather than
    // printing a week's move as a claim about a year.
    expect(
      results.periods["1w"]?.investmentMoneyWeightedReturnPercent,
    ).toBeNull();
    expect(results.periods["1w"]?.investedReasons).toContain("windowTooShort");
    expect(results.periods["1w"]?.investmentMoneyWeightedTotalPercent).toEqual(
      expect.any(Number),
    );
  });

  it("dates each preset's gaps from its own slice, as the single route does", async () => {
    // Two outages of one security: one inside the 3M window, one only the
    // wider windows reach back to. A preset folding the whole series would
    // report a gap from before its own window opened, which is a repair the
    // reader's figure does not depend on (#1392).
    const unpriced = (date: string) => {
      const p = series.find((point) => point.date === date)!;
      p.pricesComplete = false;
      p.unpricedSecurityIds = ["sec-1"];
    };
    unpriced("2026-01-05");
    unpriced("2026-01-06");
    unpriced("2026-08-10");

    const results = await batch.getPeriodResults("user-1");

    for (const preset of PORTFOLIO_PERIOD_PRESETS) {
      const expected = await single.getPeriodResult(
        "user-1",
        singleRouteArgs(preset),
      );
      expect(results.periods[preset]?.incompleteRanges).toEqual(
        expected.incompleteRanges,
      );
    }
    // Not a vacuous comparison of two empty lists: the year holds both runs,
    // the quarter only the newer one.
    expect(results.periods["1y"]?.incompleteRanges.prices).toEqual([
      { key: "sec-1", start: "2026-01-05", end: "2026-01-06" },
      { key: "sec-1", start: "2026-08-10", end: "2026-08-10" },
    ]);
    expect(results.periods["3m"]?.incompleteRanges.prices).toEqual([
      { key: "sec-1", start: "2026-08-10", end: "2026-08-10" },
    ]);
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
      { fetchMissing: undefined },
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
      { fetchMissing: undefined },
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

  /**
   * The same slicing, read through the invested measure (spec section 10): the
   * 10,000 that arrived on 2026-06-01 was INVESTED that day, so it is a capital
   * flow in the windows that contain it and factor 1 on its own day. The 2,000
   * of idle cash is in neither window's base, which is why the invested return
   * is larger than the account-level one over the same days.
   */
  it("slices the invested figures per preset from the one load", async () => {
    const results = await batch.getPeriodResults("user-1");

    expect(results.periods.ytd).toMatchObject({
      investedValueStart: 8_000,
      investedValueEnd: 18_200,
      investmentCapitalFlows: 10_000,
      investmentIncome: 0,
      investmentPnl: 200,
      // 18,000 / (8,000 + 10,000) = 1 on the purchase day, 18,200 / 18,000 on
      // the last: the deposit that was invested is not a gain.
      investmentReturnPercent: 1.11,
      investmentReturnMethod: "twr",
      investedComplete: true,
      investedReasons: [],
    });
    // The purchase is outside the 3M window, which sees only the real gain.
    expect(results.periods["3m"]).toMatchObject({
      investmentCapitalFlows: 0,
      investmentPnl: 200,
      investmentReturnPercent: 1.11,
    });
    // The account-level return over the same days divides by a base that holds
    // the idle cash, so the two measures disagree -- and each says which it is.
    expect(results.periods.ytd?.returnPercent).toBe(2);
  });

  it("loads the invested capital and income once, over the widest window", async () => {
    await batch.getPeriodResults("user-1");

    const investedQueries = queries.filter((q) =>
      q.sql.includes("it.action AS action"),
    );
    expect(investedQueries).toHaveLength(1);
    expect(investedQueries[0].params[1]).toBe("2025-09-17");
    expect(investedQueries[0].params[2]).toBe(TODAY);
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
      { fetchMissing: undefined },
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

  describe("read-path FX fill", () => {
    // A EUR deposit into a CAD-reported portfolio with no stored EUR rate: the
    // flow is the component that cannot convert, so the batch asks the
    // provider ONCE for the whole window, not once per preset (#1390).
    const eurFlow = () => {
      flowRows = [{ date: "2026-06-01", currency: "EUR", total: "10000" }];
    };

    it("asks the provider once for the month the flow could not convert", async () => {
      eurFlow();

      const results = await batch.getPeriodResults("user-1");

      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledTimes(1);
      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "EUR", to: "CAD" }],
        "2026-06-01",
      );
      // Nothing was stored: every window holding the flow stays withheld, and
      // the 3M window, which does not hold it, is unaffected.
      expect(results.periods["1y"]?.netExternalFlows).toBeNull();
      expect(results.periods["1y"]?.missingRatePairs).toContain("EUR->CAD");
      expect(results.periods["3m"]?.netExternalFlows).toBe(0);
    });

    it("re-reads the rates once and every preset sees the filled index", async () => {
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

      const results = await batch.getPeriodResults("user-1");

      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledTimes(1);
      expect(results.periods["1y"]?.netExternalFlows).toBe(15_000);
      expect(results.periods["ytd"]?.netExternalFlows).toBe(15_000);
      expect(results.periods["1y"]?.missingRatePairs).toEqual([]);
    });

    it("makes no provider call, on either half, when the caller opted out", async () => {
      eurFlow();

      const results = await batch.getPeriodResults("user-1", {
        fetchMissing: false,
      });

      expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2025-09-17",
        TODAY,
        undefined,
        "CAD",
        { fetchMissing: false },
      );
      expect(results.periods["1y"]?.netExternalFlows).toBeNull();
    });
  });
});
