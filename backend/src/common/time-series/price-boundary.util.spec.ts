import {
  BOUNDARY_LAG_DAYS,
  PRICE_WINDOW_LEAD_DAYS,
  PricePoint,
  addDays,
  closeAt,
  daysBetween,
  pointAsOf,
  priceAsOf,
  withLeadDays,
} from "./price-boundary.util";

/**
 * The boundary rules of `docs/time-series-contract.md` section 2, tested where
 * they now live. The GEM specs continue to exercise the same functions through
 * the re-export in `strategies/gem-momentum.util.ts`; these cases cover the
 * parts that only this module offers -- the sampling-aware `maxLagDays`, and the
 * lead/step arithmetic the window loaders depend on.
 */
describe("price-boundary.util", () => {
  const series: PricePoint[] = [
    { date: "2024-12-16", close: 100 },
    { date: "2024-12-30", close: 110 },
    { date: "2025-06-16", close: 120 },
  ];

  describe("pointAsOf", () => {
    it("returns the most recent observation at or before the date", () => {
      expect(pointAsOf(series, "2025-01-05")).toEqual({
        date: "2024-12-30",
        close: 110,
      });
    });

    it("returns the observation itself on an exact hit", () => {
      expect(pointAsOf(series, "2024-12-30")?.close).toBe(110);
    });

    it("returns null before the series begins, never a substituted zero", () => {
      expect(pointAsOf(series, "2024-01-01")).toBeNull();
      expect(priceAsOf(series, "2024-01-01")).toBeNull();
    });

    it("returns null for an empty series", () => {
      expect(pointAsOf([], "2025-01-01")).toBeNull();
    });
  });

  describe("closeAt", () => {
    it("accepts a close struck exactly at the lag limit", () => {
      // 2024-12-16 -> 2024-12-30 is exactly BOUNDARY_LAG_DAYS.
      expect(daysBetween("2024-12-16", "2024-12-30")).toBe(BOUNDARY_LAG_DAYS);
      expect(closeAt([series[0]], "2024-12-30")).toBe(100);
    });

    it("refuses a close one day past the limit", () => {
      expect(closeAt([series[0]], "2024-12-31")).toBeNull();
    });

    /**
     * The adversarial case the whole module exists for: an instrument whose feed
     * stopped answers every later lookup with the same number. Without the
     * bound, two boundaries months apart resolve to one close and the arithmetic
     * between them is exactly zero -- a fabricated "the market went nowhere".
     */
    it("does not carry a dead feed forward across months", () => {
      const stopped: PricePoint[] = [{ date: "2025-03-31", close: 45 }];
      expect(closeAt(stopped, "2025-04-10")).toBe(45);
      expect(closeAt(stopped, "2025-09-30")).toBeNull();
      expect(closeAt(stopped, "2025-10-31")).toBeNull();
    });

    it("widens per series when a sampling bucket is longer than the bound", () => {
      const monthly: PricePoint[] = [{ date: "2025-01-31", close: 10 }];
      expect(closeAt(monthly, "2025-02-28")).toBeNull();
      expect(closeAt(monthly, "2025-02-28", 45)).toBe(10);
    });

    it("returns null when nothing precedes the date", () => {
      expect(closeAt(series, "2024-01-01")).toBeNull();
    });
  });

  describe("date arithmetic", () => {
    it("leads a window by the lag so the boundary close is loadable", () => {
      expect(PRICE_WINDOW_LEAD_DAYS).toBe(BOUNDARY_LAG_DAYS);
      expect(withLeadDays("2025-01-01", PRICE_WINDOW_LEAD_DAYS)).toBe(
        "2024-12-18",
      );
    });

    it("steps across a leap day", () => {
      expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
      expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
      expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    });

    it("steps across a non-leap century boundary", () => {
      expect(addDays("2100-02-28", 1)).toBe("2100-03-01");
    });

    it("steps across a month end and a year end", () => {
      expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
      expect(withLeadDays("2026-01-01", 1)).toBe("2025-12-31");
    });

    it("counts whole days regardless of the local timezone", () => {
      expect(daysBetween("2025-03-30", "2025-03-31")).toBe(1);
      expect(daysBetween("2025-10-26", "2025-10-27")).toBe(1);
    });
  });
});
