import {
  GemPriceService,
  rangeMonths,
  rangeSampling,
} from "./gem-price.service";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("GemPriceService", () => {
  let service: GemPriceService;
  let manager: ManagerMock;

  beforeEach(() => {
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    service = new GemPriceService(mocks.dataSource as never);
  });

  describe("range configuration", () => {
    it("maps each range to a window and a sampling density", () => {
      expect(rangeMonths("3M")).toBe(3);
      expect(rangeMonths("MAX")).toBeNull();
      expect(rangeSampling("1Y")).toBe("day");
      expect(rangeSampling("3Y")).toBe("week");
      expect(rangeSampling("MAX")).toBe("month");
    });
  });

  describe("loadSeries", () => {
    it("groups daily closes per security, oldest first", async () => {
      manager.query.mockResolvedValue([
        { security_id: "sec-a", price_date: "2025-01-02", close_price: "10.5" },
        { security_id: "sec-a", price_date: "2025-01-03", close_price: "11" },
        { security_id: "sec-b", price_date: "2025-01-03", close_price: "20" },
      ]);

      const series = await service.loadSeries(
        ["sec-a", "sec-b"],
        "2025-01-01",
        "day",
        manager as never,
      );

      expect(series.get("sec-a")).toEqual([
        { date: "2025-01-02", close: 10.5 },
        { date: "2025-01-03", close: 11 },
      ]);
      expect(series.get("sec-b")).toHaveLength(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("FROM security_prices");
      expect(params).toEqual([["sec-a", "sec-b"], "2025-01-01"]);
    });

    it("thins long ranges to one close per bucket and sorts ascending", async () => {
      manager.query.mockResolvedValue([
        { security_id: "sec-a", price_date: "2025-02-28", close_price: "12" },
        { security_id: "sec-a", price_date: "2025-01-31", close_price: "11" },
      ]);

      const series = await service.loadSeries(
        ["sec-a"],
        "2024-01-01",
        "month",
        manager as never,
      );

      expect(series.get("sec-a")?.map((p) => p.date)).toEqual([
        "2025-01-31",
        "2025-02-28",
      ]);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("DISTINCT ON");
      expect(params[2]).toBe("month");
    });

    it("does not query for an empty security list", async () => {
      await expect(service.loadSeries([], "2025-01-01")).resolves.toEqual(
        new Map(),
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("opens its own scoped transaction when no manager is passed", async () => {
      manager.query.mockResolvedValue([]);
      await service.loadSeries(["sec-a"], "2025-01-01");
      expect(manager.query).toHaveBeenCalled();
    });
  });

  describe("latestPrices", () => {
    it("returns the newest close per security", async () => {
      manager.query.mockResolvedValue([
        { security_id: "sec-a", close_price: "452.475" },
      ]);
      const prices = await service.latestPrices(["sec-a"], manager as never);
      expect(prices.get("sec-a")).toBe(452.475);
    });

    it("leaves an unpriced security out of the map", async () => {
      manager.query.mockResolvedValue([]);
      const prices = await service.latestPrices(["sec-a"], manager as never);
      expect(prices.has("sec-a")).toBe(false);
    });

    it("skips the query with no securities", async () => {
      await expect(service.latestPrices([])).resolves.toEqual(new Map());
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("opens its own scoped transaction when no manager is passed", async () => {
      manager.query.mockResolvedValue([
        { security_id: "sec-a", close_price: "7" },
      ]);
      const prices = await service.latestPrices(["sec-a"]);
      expect(prices.get("sec-a")).toBe(7);
    });
  });

  describe("latestPriceDate", () => {
    it("returns the newest price date across the securities", async () => {
      manager.query.mockResolvedValue([{ latest: "2025-08-02" }]);
      await expect(
        service.latestPriceDate(["sec-a"], manager as never),
      ).resolves.toBe("2025-08-02");
    });

    it("opens its own scoped transaction when no manager is passed", async () => {
      manager.query.mockResolvedValue([{ latest: "2025-08-02" }]);
      await expect(service.latestPriceDate(["sec-a"])).resolves.toBe(
        "2025-08-02",
      );
    });

    it("is null when nothing is priced", async () => {
      manager.query.mockResolvedValue([{ latest: null }]);
      await expect(
        service.latestPriceDate(["sec-a"], manager as never),
      ).resolves.toBeNull();
      await expect(service.latestPriceDate([])).resolves.toBeNull();
    });
  });
});
