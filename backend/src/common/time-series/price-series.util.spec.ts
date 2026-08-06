import { EntityManager } from "typeorm";
import { loadPriceSeries } from "./price-series.util";

/**
 * The per-series basis rule of `docs/time-series-contract.md` rule 1.
 *
 * A unit spec cannot execute the SQL, so the semantic half of the rule is
 * asserted against the statement the loader emits -- the per-row fallback must
 * not come back, and the per-series decision must be there -- while the row
 * mapping is asserted against driver-shaped fixtures. `has_adjusted` is a
 * boolean and the numerics come back as strings, which is what `pg` returns for
 * `NUMERIC`; a fixture using JavaScript numbers there would be a shape the
 * driver never produces (financial contract section 8.3).
 */
function managerReturning(rows: unknown[]): {
  manager: EntityManager;
  query: jest.Mock;
} {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
}

describe("loadPriceSeries", () => {
  it("does not query for an empty id list", async () => {
    const { manager, query } = managerReturning([]);
    await expect(
      loadPriceSeries(manager, {
        table: "security_prices",
        ids: [],
        fromDate: "2025-01-01",
      }),
    ).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("groups closes per instrument, oldest first, with the basis", async () => {
    const { manager } = managerReturning([
      {
        series_id: "sec-a",
        price_date: "2025-01-03",
        close_price: "11",
        has_adjusted: true,
      },
      {
        series_id: "sec-a",
        price_date: "2025-01-02",
        close_price: "10.5",
        has_adjusted: true,
      },
      {
        series_id: "sec-b",
        price_date: "2025-01-03",
        close_price: "20",
        has_adjusted: false,
      },
    ]);

    const series = await loadPriceSeries(manager, {
      table: "security_prices",
      ids: ["sec-a", "sec-b"],
      fromDate: "2025-01-01",
    });

    expect(series.get("sec-a")).toEqual({
      basis: "ADJUSTED",
      points: [
        { date: "2025-01-02", close: 10.5 },
        { date: "2025-01-03", close: 11 },
      ],
    });
    expect(series.get("sec-b")?.basis).toBe("RAW");
  });

  it("leaves an instrument with no rows absent, not present and empty", async () => {
    const { manager } = managerReturning([]);
    const series = await loadPriceSeries(manager, {
      table: "security_prices",
      ids: ["sec-a"],
      fromDate: "2025-01-01",
    });
    // Absent is what tells "nothing to price it with" apart from "priced at
    // zero"; an empty array in the map would read as the latter.
    expect(series.has("sec-a")).toBe(false);
  });

  /**
   * Rule 1: never mix adjusted and raw prices for one instrument. The per-row
   * `COALESCE(adjusted_close, close_price)` is the shape that looks like the
   * same thing and is not -- it splices a transaction-derived raw close into an
   * adjusted series, which around a split is a several-hundred-percent return
   * that never happened.
   */
  it("picks one basis per series instead of per row", async () => {
    for (const sampling of ["day", "week", "month"] as const) {
      const { manager, query } = managerReturning([]);
      await loadPriceSeries(manager, {
        table: "security_prices",
        ids: ["sec-a"],
        fromDate: "2025-01-01",
        sampling,
      });
      const sql = query.mock.calls[0][0] as string;
      expect(sql).not.toMatch(/COALESCE\s*\(\s*adjusted_close/i);
      expect(sql).toContain("bool_or(adjusted_close IS NOT NULL)");
      expect(sql).toContain(
        "b.has_adjusted = false OR s.adjusted_close IS NOT NULL",
      );
    }
  });

  it("reads the index table through the same door", async () => {
    const { manager, query } = managerReturning([]);
    await loadPriceSeries(manager, {
      table: "market_index_prices",
      ids: ["SP500"],
      fromDate: "2025-01-01",
    });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("FROM market_index_prices");
    expect(sql).toContain("index_code = ANY($1::text[])");
    expect(sql).not.toMatch(/COALESCE\s*\(\s*adjusted_close/i);
  });

  it("passes the upper bound as a parameter, never as text", async () => {
    const { manager, query } = managerReturning([]);
    await loadPriceSeries(manager, {
      table: "security_prices",
      ids: ["sec-a"],
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
      sampling: "month",
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("price_date <= $3::date");
    expect(params).toEqual([["sec-a"], "2025-01-01", "2025-12-31", "month"]);
    // The sampling parameter must not collide with the optional upper bound --
    // getting the ordering wrong here silently buckets by a date string.
    expect(sql).toContain("date_trunc($4, price_date)");
  });

  it("orders the sampling parameter correctly without an upper bound", async () => {
    const { manager, query } = managerReturning([]);
    await loadPriceSeries(manager, {
      table: "security_prices",
      ids: ["sec-a"],
      fromDate: "2025-01-01",
      sampling: "week",
    });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([["sec-a"], "2025-01-01", "week"]);
    expect(sql).toContain("date_trunc($3, price_date)");
  });
});
