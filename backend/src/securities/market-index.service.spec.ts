import {
  INDEX_FETCH_COOLDOWN_MS,
  MarketIndexService,
} from "./market-index.service";
import { YahooFinanceService } from "./yahoo-finance.service";
import { HistoricalPrice } from "./providers/quote-provider.interface";
import { MARKET_INDEXES } from "./market-indexes";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const systemContext = jest.fn((fn: () => unknown) => fn());
jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => systemContext(fn),
}));

/** A provider bar, typed so the fixture cannot claim a shape Yahoo never sends. */
function bar(
  date: string,
  close: number,
  adjClose: number | null = null,
): HistoricalPrice {
  return {
    date: new Date(`${date}T00:00:00Z`),
    open: null,
    high: null,
    low: null,
    close,
    adjClose,
    volume: null,
  };
}

describe("MarketIndexService", () => {
  let service: MarketIndexService;
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let yahoo: jest.Mocked<
    Pick<YahooFinanceService, "fetchHistorical" | "fetchHistoricalWindow">
  >;

  /** SQL statements the service issued, in order. */
  const statements = (): string[] =>
    manager.query.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    jest.clearAllMocks();
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    manager.query.mockResolvedValue([]);
    yahoo = {
      fetchHistorical: jest.fn().mockResolvedValue(null),
      fetchHistoricalWindow: jest.fn().mockResolvedValue(null),
    };
    service = new MarketIndexService(dataSource as never, yahoo as never);
  });

  // --- catalog -------------------------------------------------------------

  describe("listCatalog", () => {
    it("reports no coverage for an index we hold nothing for", async () => {
      manager.query.mockResolvedValue([]);
      const catalog = await service.listCatalog();
      expect(catalog).toHaveLength(MARKET_INDEXES.length);
      // Null on both ends is "we hold nothing", which the picker has to be able
      // to tell apart from a coverage window that is merely short.
      expect(catalog[0].coverage).toEqual({
        earliestDate: null,
        latestDate: null,
      });
    });

    it("attaches the stored window to the catalog entry", async () => {
      manager.query.mockResolvedValue([
        { index_code: "SP500", earliest: "2015-01-02", latest: "2026-08-05" },
      ]);
      const catalog = await service.listCatalog();
      const sp500 = catalog.find((index) => index.code === "SP500");
      expect(sp500?.coverage).toEqual({
        earliestDate: "2015-01-02",
        latestDate: "2026-08-05",
      });
      expect(sp500?.yahooSymbol).toBe("^GSPC");
    });
  });

  // --- on-demand backfill --------------------------------------------------

  describe("ensureHistory", () => {
    it("does nothing for an empty selection", async () => {
      await service.ensureHistory([], "2025-01-01");
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("ignores a code that is not in the catalog", async () => {
      await service.ensureHistory(["NOT_AN_INDEX"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    /**
     * A generous horizon whatever window was asked for. A first fetch bounded to
     * the request would store exactly that span and then sit behind the cooldown
     * for six hours, so a user who widened the window straight afterwards would
     * be told the benchmark could not be priced at the new boundary.
     */
    it("fetches a deep history the first time an index is asked for", async () => {
      // No coverage rows, no sync rows.
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900),
        bar("2025-01-03", 5910),
      ]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      const [symbol, from] = yahoo.fetchHistoricalWindow.mock.calls[0];
      expect(symbol).toBe("^GSPC");
      expect(Number(from.toISOString().slice(0, 4))).toBeLessThan(2010);
      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(true);
    });

    /**
     * `range=max` is the shorthand that drops granularity: asked for its whole
     * history an index answers with coarser bars, and those were then stored as
     * if they were the daily series. Nothing here may reach for it.
     */
    it("never asks for the provider's whole-history shorthand", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], null);
      await service.ensureHistory(["DAX"], "2025-01-01");
      await service.refreshAll();

      expect(yahoo.fetchHistorical).not.toHaveBeenCalled();
    });

    it("refuses a series coarser than daily rather than storing it", async () => {
      manager.query.mockResolvedValue([]);
      // Month-end closes: what the whole-history shorthand hands back, and what
      // drew the benchmark as a row of flat stubs once stored.
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-31", 5900),
        bar("2025-02-28", 5950),
        bar("2025-03-31", 6000),
        bar("2025-04-30", 6100),
      ]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(false);
      // Unpriced, which the comparison reports as an exclusion the user can act
      // on -- not a sparse series masquerading as a daily one.
      expect(statements().some((sql) => sql.includes("last_error = $2"))).toBe(
        true,
      );
    });

    it("accepts a daily series despite its weekend and holiday steps", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900),
        bar("2025-01-03", 5910),
        // Weekend.
        bar("2025-01-06", 5920),
        bar("2025-01-07", 5930),
        bar("2025-01-08", 5940),
        // A closure of several days must not make a daily series look weekly.
        bar("2025-01-15", 5950),
      ]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(true);
    });

    it("stores a single-bar top-up, which has no spacing to judge", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve([
            {
              index_code: "SP500",
              earliest: "2001-01-02",
              latest: "2020-06-01",
            },
          ]);
        }
        return Promise.resolve([]);
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(true);
    });

    it("tops an existing history up with a bounded window, not the whole thing", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve([
            {
              index_code: "SP500",
              earliest: "2020-01-02",
              latest: "2020-06-01",
            },
          ]);
        }
        return Promise.resolve([]);
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(1);
      const [symbol, from] = yahoo.fetchHistoricalWindow.mock.calls[0];
      expect(symbol).toBe("^GSPC");
      // The lookup that prices the window start searches backwards, so the
      // fetch has to reach behind the boundary.
      expect(from.toISOString().slice(0, 10) < "2025-01-01").toBe(true);
      expect(yahoo.fetchHistorical).not.toHaveBeenCalled();
    });

    /**
     * "All time" has no boundary to reach behind, so no stored start can fail
     * to satisfy it. Treating it as unsatisfiable would refetch every selected
     * index on every open-ended request.
     */
    it("does not refetch on an open-ended request when the store is current", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve([
            {
              index_code: "SP500",
              earliest: "2000-01-03",
              latest: new Date().toISOString().slice(0, 10),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      await service.ensureHistory(["SP500"], null);
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
      expect(yahoo.fetchHistorical).not.toHaveBeenCalled();
    });

    it("fetches the default horizon on an open-ended request with nothing stored", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2001-01-03", 1400)]);

      await service.ensureHistory(["SP500"], null);

      // Still an explicit window, and a deep one: there is no start date to
      // bound it with, but asking for everything costs the daily granularity.
      const [, from, to] = yahoo.fetchHistoricalWindow.mock.calls[0];
      const years = (to.getTime() - from.getTime()) / (365.25 * 86_400_000);
      expect(years).toBeGreaterThan(20);
    });

    it("does not refetch an index whose stored history already covers the window", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve([
            {
              index_code: "SP500",
              earliest: "2000-01-03",
              latest: new Date().toISOString().slice(0, 10),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      await service.ensureHistory(["SP500"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    /**
     * The whole reason `market_index_sync` exists. A provider that cannot serve
     * an index leaves no rows, so the coverage test stays false -- without the
     * cooldown the backfill fires again on the very next chart render.
     */
    it("does not retry within the cooldown, even with nothing stored", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("last_attempt_at")) {
          return Promise.resolve([
            { index_code: "SP500", last_attempt_at: new Date() },
          ]);
        }
        return Promise.resolve([]);
      });

      await service.ensureHistory(["SP500"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    it("retries once the cooldown has elapsed", async () => {
      const stale = new Date(Date.now() - INDEX_FETCH_COOLDOWN_MS - 1000);
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("last_attempt_at") && sql.includes("SELECT")) {
          return Promise.resolve([
            { index_code: "SP500", last_attempt_at: stale },
          ]);
        }
        return Promise.resolve([]);
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(1);
    });

    /**
     * A provider outage must leave the index *unpriced*, which the comparison
     * then reports as an exclusion. Turning it into a thrown error would take
     * the securities' lines down with the benchmark.
     */
    it("records a failure and does not throw when the provider returns nothing", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue(null);
      await expect(
        service.ensureHistory(["SP500"], "2025-01-01"),
      ).resolves.toBeUndefined();
      expect(statements().some((sql) => sql.includes("last_error = $2"))).toBe(
        true,
      );
      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(false);
    });

    it("records a failure and does not throw when the provider raises", async () => {
      yahoo.fetchHistoricalWindow.mockRejectedValue(new Error("429 throttled"));
      await expect(
        service.ensureHistory(["SP500"], "2025-01-01"),
      ).resolves.toBeUndefined();
      expect(statements().some((sql) => sql.includes("last_error = $2"))).toBe(
        true,
      );
    });

    it("stamps the attempt before the fetch, so a hang still cools down", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue(null);
      await service.ensureHistory(["SP500"], "2025-01-01");
      const insertIndex = statements().findIndex((sql) =>
        sql.includes("INSERT INTO market_index_sync"),
      );
      expect(insertIndex).toBeGreaterThanOrEqual(0);
    });

    it("drops bars the provider could not price, rather than storing a zero", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900),
        bar("2025-01-03", 0),
        bar("2025-01-06", Number.NaN),
      ]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      const insert = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO market_index_prices"),
      );
      // Five bound parameters per row; one usable bar.
      expect(insert?.[1]).toHaveLength(5);
      expect(insert?.[1]).toContain(5900);
    });

    it("refuses to erase a stored adjusted close with a null one", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);
      await service.ensureHistory(["SP500"], "2025-01-01");
      const insert = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO market_index_prices"),
      );
      // Without the COALESCE a provider with no adjusted close silently flips a
      // series' basis from adjusted to raw between two reads.
      expect(String(insert?.[0]).replace(/\s+/g, " ")).toContain(
        "adjusted_close = COALESCE(EXCLUDED.adjusted_close, market_index_prices.adjusted_close)",
      );
    });

    it("keeps an adjusted close the provider did supply", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900, 5850),
      ]);
      await service.ensureHistory(["SP500"], "2025-01-01");
      const insert = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO market_index_prices"),
      );
      expect(insert?.[1]).toContain(5850);
    });
  });

  // --- start-up ------------------------------------------------------------

  describe("onApplicationBootstrap", () => {
    /**
     * Without this a fresh deployment holds no index prices until the first
     * weekday 17:10 ET, and every benchmark in the picker is one we cannot
     * draw.
     */
    it("warms the store under system context", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2001-01-03", 1400)]);

      service.onApplicationBootstrap();
      await new Promise((resolve) => setImmediate(resolve));

      expect(systemContext).toHaveBeenCalledTimes(1);
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalled();
    });

    it("returns before the provider does, so start-up is not blocked", () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockReturnValue(new Promise(() => {}));
      expect(service.onApplicationBootstrap()).toBeUndefined();
    });

    it("does not take the process down when the provider is unreachable", async () => {
      manager.query.mockRejectedValue(new Error("db asleep"));
      service.onApplicationBootstrap();
      await expect(
        new Promise((resolve) => setImmediate(resolve)),
      ).resolves.toBeUndefined();
    });
  });

  // --- scheduled refresh ---------------------------------------------------

  describe("scheduledRefresh", () => {
    it("seeds its own system context, since no request is behind it", async () => {
      await service.scheduledRefresh();
      expect(systemContext).toHaveBeenCalledTimes(1);
    });

    it("asks for a short recent window where history exists", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve(
            MARKET_INDEXES.map((index) => ({
              index_code: index.code,
              earliest: "2000-01-03",
              latest: "2026-08-05",
            })),
          );
        }
        return Promise.resolve([]);
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2026-08-05", 100)]);

      await service.refreshAll();

      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(
        MARKET_INDEXES.length,
      );
      // A deep history is thousands of bars; the daily top-up must not ask for
      // one -- the window it passes is the giveaway.
      const [, from, to] = yahoo.fetchHistoricalWindow.mock.calls[0];
      const days = (to.getTime() - from.getTime()) / 86_400_000;
      expect(days).toBeLessThan(30);
    });

    it("asks for the default horizon for an index it holds nothing for", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2001-01-03", 1400)]);

      await service.refreshAll();

      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(
        MARKET_INDEXES.length,
      );
      const [, from, to] = yahoo.fetchHistoricalWindow.mock.calls[0];
      const years = (to.getTime() - from.getTime()) / (365.25 * 86_400_000);
      expect(years).toBeGreaterThan(20);
    });

    it("carries on past an index the provider cannot serve", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow
        .mockRejectedValueOnce(new Error("gone"))
        .mockResolvedValue([bar("2001-01-03", 1400)]);

      await expect(service.refreshAll()).resolves.toBeUndefined();
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(
        MARKET_INDEXES.length,
      );
    });
  });

  // --- reads ---------------------------------------------------------------

  describe("loadSeries", () => {
    it("does not query for an empty selection", async () => {
      await expect(service.loadSeries([], "2025-01-01")).resolves.toEqual(
        new Map(),
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("reads the index table through the shared basis loader", async () => {
      manager.query.mockResolvedValue([
        {
          series_id: "SP500",
          price_date: "2025-01-02",
          close_price: "5900",
          has_adjusted: false,
        },
      ]);
      const series = await service.loadSeries(["SP500"], "2025-01-01");
      expect(series.get("SP500")).toEqual({
        basis: "RAW",
        points: [{ date: "2025-01-02", close: 5900 }],
      });
      expect(statements()[0]).toContain("FROM market_index_prices");
    });
  });
});
