import {
  addMonthsUtc,
  cadenceMonths,
  evaluate,
  historyAction,
  momentumSnapshot,
  parseYmd,
  periodFor,
  priceAsOf,
  rankEquities,
  recentPeriods,
  trailingReturnPercent,
  PricePoint,
} from "./gem-momentum.util";

const series = (points: Array<[string, number]>): PricePoint[] =>
  points.map(([date, close]) => ({ date, close }));

describe("gem-momentum.util", () => {
  describe("date helpers", () => {
    it("parses a date-only string as UTC midnight", () => {
      expect(parseYmd("2025-08-01").toISOString()).toBe(
        "2025-08-01T00:00:00.000Z",
      );
    });

    it("clamps a month shift to the target month's last day", () => {
      expect(addMonthsUtc(parseYmd("2025-03-31"), -1).toISOString()).toContain(
        "2025-02-28",
      );
      expect(addMonthsUtc(parseYmd("2024-01-31"), 1).toISOString()).toContain(
        "2024-02-29",
      );
    });

    it("maps cadence to a month step", () => {
      expect(cadenceMonths("MONTHLY")).toBe(1);
      expect(cadenceMonths("QUARTERLY")).toBe(3);
    });
  });

  describe("periodFor", () => {
    it("decides a monthly period on the last day of the previous month", () => {
      expect(periodFor("2025-08-14", "MONTHLY")).toEqual({
        evaluatedOn: "2025-07-31",
        effectiveFrom: "2025-08-01",
      });
    });

    it("aligns a quarterly period to the calendar quarter", () => {
      expect(periodFor("2025-08-14", "QUARTERLY")).toEqual({
        evaluatedOn: "2025-06-30",
        effectiveFrom: "2025-07-01",
      });
      expect(periodFor("2025-01-02", "QUARTERLY")).toEqual({
        evaluatedOn: "2024-12-31",
        effectiveFrom: "2025-01-01",
      });
    });
  });

  describe("recentPeriods", () => {
    it("returns the requested number of periods, oldest first", () => {
      const periods = recentPeriods("2025-08-14", "MONTHLY", 3);
      expect(periods.map((p) => p.effectiveFrom)).toEqual([
        "2025-06-01",
        "2025-07-01",
        "2025-08-01",
      ]);
      expect(periods.map((p) => p.evaluatedOn)).toEqual([
        "2025-05-31",
        "2025-06-30",
        "2025-07-31",
      ]);
    });

    it("steps by quarters for a quarterly strategy", () => {
      expect(
        recentPeriods("2025-08-14", "QUARTERLY", 2).map((p) => p.effectiveFrom),
      ).toEqual(["2025-04-01", "2025-07-01"]);
    });

    it("returns nothing for a non-positive count", () => {
      expect(recentPeriods("2025-08-14", "MONTHLY", 0)).toEqual([]);
    });
  });

  describe("priceAsOf", () => {
    const prices = series([
      ["2025-01-02", 100],
      ["2025-01-03", 101],
      ["2025-01-06", 103],
    ]);

    it("returns the close on the date when one exists", () => {
      expect(priceAsOf(prices, "2025-01-03")).toBe(101);
    });

    it("falls back to the most recent earlier close", () => {
      expect(priceAsOf(prices, "2025-01-05")).toBe(101);
      expect(priceAsOf(prices, "2025-02-01")).toBe(103);
    });

    it("returns null before the series starts", () => {
      expect(priceAsOf(prices, "2024-12-31")).toBeNull();
      expect(priceAsOf([], "2025-01-03")).toBeNull();
    });
  });

  describe("trailingReturnPercent", () => {
    const prices = series([
      ["2024-07-31", 100],
      ["2025-07-31", 115.42],
    ]);

    it("computes a total return in percent", () => {
      expect(trailingReturnPercent(prices, "2024-07-31", "2025-07-31")).toBe(
        15.42,
      );
    });

    it("is unknown when a price is missing or the base is not positive", () => {
      expect(
        trailingReturnPercent(prices, "2020-01-01", "2025-07-31"),
      ).toBeNull();
      expect(
        trailingReturnPercent(
          series([
            ["2024-07-31", 0],
            ["2025-07-31", 10],
          ]),
          "2024-07-31",
          "2025-07-31",
        ),
      ).toBeNull();
    });
  });

  describe("momentumSnapshot", () => {
    it("computes each role's lookback return and marks gaps unknown", () => {
      const snapshot = momentumSnapshot(
        {
          US_EQUITY: series([
            ["2024-07-31", 100],
            ["2025-07-31", 115],
          ]),
          SAFE: series([
            ["2024-07-31", 100],
            ["2025-07-31", 104],
          ]),
          EM_EQUITY: series([["2025-07-31", 50]]), // history too short
          EX_US_EQUITY: [],
        },
        "2025-07-31",
        12,
      );
      expect(snapshot.US_EQUITY).toBe(15);
      expect(snapshot.SAFE).toBe(4);
      expect(snapshot.EM_EQUITY).toBeNull();
      expect(snapshot.EX_US_EQUITY).toBeNull();
    });
  });

  describe("rankEquities", () => {
    it("ranks known equity momentum strongest first and drops unknowns", () => {
      const ranked = rankEquities({
        US_EQUITY: 15.42,
        EX_US_EQUITY: 8.31,
        EM_EQUITY: 29.87,
        SAFE: 4.21,
      });
      expect(ranked.map((entry) => entry.role)).toEqual([
        "EM_EQUITY",
        "US_EQUITY",
        "EX_US_EQUITY",
      ]);
    });

    it("keeps only eligible roles and breaks ties on canonical order", () => {
      const ranked = rankEquities(
        { US_EQUITY: 5, EX_US_EQUITY: 5, EM_EQUITY: null },
        ["US_EQUITY", "EX_US_EQUITY"],
      );
      expect(ranked.map((entry) => entry.role)).toEqual([
        "US_EQUITY",
        "EX_US_EQUITY",
      ]);
    });
  });

  describe("evaluate", () => {
    it("is RISK_ON with the strongest equity market as target", () => {
      const outcome = evaluate({
        US_EQUITY: 15.42,
        EX_US_EQUITY: 8.31,
        EM_EQUITY: 29.87,
        SAFE: 4.21,
      });
      expect(outcome).toMatchObject({
        state: "RISK_ON",
        targetRole: "EM_EQUITY",
        spreadPp: 11.21,
        leadPp: 14.45,
      });
    });

    it("is RISK_OFF with the safe asset as target when equities lose", () => {
      const outcome = evaluate({
        US_EQUITY: -1.28,
        EX_US_EQUITY: 1.45,
        EM_EQUITY: 3.12,
        SAFE: 3.76,
      });
      expect(outcome).toMatchObject({
        state: "RISK_OFF",
        targetRole: "SAFE",
        spreadPp: -5.04,
        leadPp: null,
      });
      // The ranking is still computed -- it just does not drive the allocation.
      expect(outcome?.ranking).toHaveLength(3);
    });

    it("treats an equal reading as RISK_OFF (equities must win outright)", () => {
      expect(evaluate({ US_EQUITY: 4, SAFE: 4 })?.state).toBe("RISK_OFF");
    });

    it("cannot evaluate without both absolute-test inputs", () => {
      expect(evaluate({ US_EQUITY: 10, SAFE: null })).toBeNull();
      expect(evaluate({ US_EQUITY: null, SAFE: 2 })).toBeNull();
      expect(evaluate({})).toBeNull();
    });

    it("has no target while RISK_ON with no eligible equity instrument", () => {
      const outcome = evaluate({ US_EQUITY: 10, SAFE: 2 }, []);
      expect(outcome).toMatchObject({ state: "RISK_ON", targetRole: null });
      expect(outcome?.leadPp).toBeNull();
    });

    it("measures against the risk-free leg when one is assigned", () => {
      // Equities beat the bond fund but not T-bills: the two roles disagree, so
      // which one is the yardstick decides the signal.
      const momentum = { US_EQUITY: 3, SAFE: 1, RISK_FREE: 5 };
      const withRiskFree = evaluate(momentum, [
        "US_EQUITY",
        "SAFE",
        "RISK_FREE",
      ]);
      expect(withRiskFree).toMatchObject({
        state: "RISK_OFF",
        benchmarkRole: "RISK_FREE",
        spreadPp: -2,
        // RISK-OFF still moves into the safe asset, not into the yardstick.
        targetRole: "SAFE",
      });
    });

    it("falls back to the safe asset when no risk-free leg is assigned", () => {
      const outcome = evaluate({ US_EQUITY: 3, SAFE: 1, RISK_FREE: 5 }, [
        "US_EQUITY",
        "SAFE",
      ]);
      // The risk-free momentum is present but unmapped, so it is not consulted:
      // a configuration made before the split evaluates exactly as it used to.
      expect(outcome).toMatchObject({
        state: "RISK_ON",
        benchmarkRole: "SAFE",
        spreadPp: 2,
      });
    });

    it("holds the risk-free leg when it is the only defensive instrument", () => {
      const outcome = evaluate({ US_EQUITY: -4, RISK_FREE: 2 }, [
        "US_EQUITY",
        "RISK_FREE",
      ]);
      expect(outcome).toMatchObject({
        state: "RISK_OFF",
        benchmarkRole: "RISK_FREE",
        targetRole: "RISK_FREE",
      });
    });

    it("cannot evaluate when the assigned risk-free leg has no momentum", () => {
      // SAFE has a reading, but it is not the benchmark any more -- guessing
      // with it would report a spread the strategy did not measure.
      expect(
        evaluate({ US_EQUITY: 10, SAFE: 2, RISK_FREE: null }, [
          "US_EQUITY",
          "SAFE",
          "RISK_FREE",
        ]),
      ).toBeNull();
    });
  });

  describe("historyAction", () => {
    it("labels the first allocation, a switch and a hold", () => {
      expect(historyAction("EM_EQUITY", null)).toBe("BUY");
      expect(historyAction("EM_EQUITY", "US_EQUITY")).toBe("SWITCH");
      expect(historyAction("EM_EQUITY", "EM_EQUITY")).toBe("HOLD");
      expect(historyAction(null, "EM_EQUITY")).toBe("HOLD");
    });
  });
});
