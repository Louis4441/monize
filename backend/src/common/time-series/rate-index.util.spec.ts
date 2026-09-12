import {
  RateIndexRow,
  buildRateIndex,
  convertAtDate,
  findBestRate,
  indexRateRows,
} from "./rate-index.util";

const row = (
  from: string,
  to: string,
  rate: number,
  date: string,
): RateIndexRow => ({
  from_currency: from,
  to_currency: to,
  rate: String(rate),
  rate_date: date,
});

describe("rate-index.util", () => {
  describe("buildRateIndex", () => {
    it("asks for nothing when no currency needs converting", async () => {
      const query = jest.fn();
      const index = await buildRateIndex(
        query,
        new Set(),
        "CAD",
        "2026-06-01",
        "2026-06-30",
      );
      expect(index.size).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it("loads both directions of every pair, ordered by date", async () => {
      const query = jest.fn().mockResolvedValue([]);
      await buildRateIndex(
        query,
        new Set(["USD", "EUR"]),
        "CAD",
        "2026-06-01",
        "2026-06-30",
      );

      const [sql, params] = query.mock.calls[0];
      // Both directions: convertWithRateLookup falls back to the inverse rate,
      // and loading one direction would make that fallback unreachable.
      expect(sql).toContain(
        "from_currency = ANY($1::TEXT[]) AND to_currency = $2",
      );
      expect(sql).toContain(
        "from_currency = $2 AND to_currency = ANY($1::TEXT[])",
      );
      // findBestRate walks forward and stops at the first date past the target,
      // so the ordering is part of the contract, not a convenience.
      expect(sql).toContain("ORDER BY rate_date");
      expect(params).toEqual([
        ["USD", "EUR"],
        "CAD",
        "2026-06-01",
        "2026-06-30",
      ]);
    });

    it("loads a margin either side of the reported window", async () => {
      const query = jest.fn().mockResolvedValue([]);
      await buildRateIndex(
        query,
        new Set(["USD"]),
        "CAD",
        "2026-06-01",
        "2026-06-30",
      );
      const [sql] = query.mock.calls[0];
      expect(sql).toContain("($3::DATE - INTERVAL '90 days')");
      expect(sql).toContain("($4::DATE + INTERVAL '31 days')");
    });
  });

  describe("indexRateRows", () => {
    it("keys by pair and coerces the numeric and date columns", () => {
      const index = indexRateRows([
        row("USD", "CAD", 1.365, "2026-06-15"),
        row("USD", "CAD", 1.37, "2026-06-16"),
        row("CAD", "USD", 0.73, "2026-06-15"),
      ]);

      expect(index.get("USD->CAD")).toEqual([
        { date: "2026-06-15", rate: 1.365 },
        { date: "2026-06-16", rate: 1.37 },
      ]);
      expect(index.get("CAD->USD")).toEqual([
        { date: "2026-06-15", rate: 0.73 },
      ]);
    });

    it("reads a Date the driver handed back as a calendar date", () => {
      const index = indexRateRows([
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate: 1.5,
          rate_date: new Date("2026-06-15T00:00:00.000Z"),
        },
      ]);
      expect(index.get("USD->CAD")).toEqual([
        { date: "2026-06-15", rate: 1.5 },
      ]);
    });
  });

  describe("findBestRate", () => {
    const rates = [
      { date: "2026-06-10", rate: 1.3 },
      { date: "2026-06-15", rate: 1.365 },
      { date: "2026-06-20", rate: 1.4 },
    ];

    it("takes the most recent rate on or before the date", () => {
      expect(findBestRate(rates, "USD->CAD", "2026-06-17")).toBe(1.365);
      expect(findBestRate(rates, "USD->CAD", "2026-06-15")).toBe(1.365);
    });

    it("takes the latest rate when the date is past the whole history", () => {
      expect(findBestRate(rates, "USD->CAD", "2027-01-01")).toBe(1.4);
    });

    it("is undefined when the pair has no rates at all", () => {
      expect(findBestRate([], "USD->CAD", "2026-06-17")).toBeUndefined();
    });

    it("falls back to the earliest rate before the history, and says so once", () => {
      // A fresh array per case: the once-per-computation warning is keyed by the
      // array object, which is exactly the behaviour being pinned here.
      const own = [...rates];
      const logger = { warn: jest.fn() };
      expect(findBestRate(own, "USD->CAD", "2026-01-01", logger)).toBe(1.3);
      expect(findBestRate(own, "USD->CAD", "2026-02-01", logger)).toBe(1.3);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain("look-ahead, DR-02");
    });
  });

  describe("convertAtDate", () => {
    const index = indexRateRows([
      row("USD", "CAD", 1.3, "2026-06-10"),
      row("USD", "CAD", 1.365, "2026-06-15"),
    ]);

    it("converts at the rate that stood on the day, not the latest one", () => {
      expect(convertAtDate(1000, "USD", "CAD", "2026-06-12", index)).toBe(1300);
      expect(convertAtDate(1000, "USD", "CAD", "2026-06-15", index)).toBe(1365);
    });

    it("returns the amount unchanged for the reporting currency itself", () => {
      expect(convertAtDate(1234.56, "CAD", "CAD", "2026-06-15", index)).toBe(
        1234.56,
      );
    });

    it("uses the reciprocal when only the inverse pair is stored", () => {
      const inverse = indexRateRows([row("CAD", "USD", 0.8, "2026-06-15")]);
      expect(convertAtDate(80, "USD", "CAD", "2026-06-15", inverse)).toBe(100);
    });

    it("is null, never the amount unchanged, when no rate exists", () => {
      const logger = { warn: jest.fn() };
      expect(
        convertAtDate(1000, "JPY", "CAD", "2026-06-15", index, logger),
      ).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain(
        "rather than converted 1:1",
      );
    });

    it("converts zero to zero with no rate and records no gap", () => {
      const logger = { warn: jest.fn() };
      expect(convertAtDate(0, "JPY", "CAD", "2026-06-15", index, logger)).toBe(
        0,
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("treats a zero or negative stored rate as absent", () => {
      const broken = indexRateRows([row("USD", "CAD", 0, "2026-06-15")]);
      expect(
        convertAtDate(1000, "USD", "CAD", "2026-06-15", broken),
      ).toBeNull();
    });
  });
});
