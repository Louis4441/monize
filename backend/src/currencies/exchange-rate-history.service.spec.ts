import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  ExchangeRateHistoryService,
  oneYearEarlierYMD,
} from "./exchange-rate-history.service";
import { ExchangeRateService } from "./exchange-rate.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The empty-coverage window is anchored on today, so today has to be a fixture
// or "which year did it ask for" becomes a question about the day the suite
// runs. Only `todayYMD` is replaced; `addDaysYMD` beside it is the real thing.
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

describe("ExchangeRateHistoryService", () => {
  let service: ExchangeRateHistoryService;
  let manager: Record<string, jest.Mock>;
  let dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  /** The rows `readCoverage`'s aggregate returns, in call order. */
  const coverageRows = (
    ...rows: Array<{
      earliest: string | null;
      latest: string | null;
      observations: string;
    }>
  ) => {
    let call = 0;
    manager.query.mockImplementation(() => {
      const row = rows[Math.min(call, rows.length - 1)];
      call += 1;
      return Promise.resolve([row]);
    });
  };

  beforeEach(async () => {
    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "PLN" }),
    };
    ({ manager, dataSource } = createScopedDbMocks([
      [UserPreference, userPreferenceRepository],
    ]));
    exchangeRateService = {
      fillRateWindow: jest
        .fn()
        .mockResolvedValue({ stored: 240, answered: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeRateHistoryService,
        { provide: DataSource, useValue: dataSource },
        { provide: ExchangeRateService, useValue: exchangeRateService },
      ],
    }).compile();

    service = module.get(ExchangeRateHistoryService);
  });

  describe("oneYearEarlierYMD()", () => {
    it("steps back a calendar year, not 365 days, across a leap year", () => {
      // 2025-03-01 minus a year is 2024-03-01, which is 366 days back.
      expect(oneYearEarlierYMD("2025-03-01")).toBe("2024-03-01");
    });

    it("clamps February 29 to February 28 rather than rolling into March", () => {
      expect(oneYearEarlierYMD("2024-02-29")).toBe("2023-02-28");
    });

    it("keeps a month end a month end", () => {
      expect(oneYearEarlierYMD("2026-01-31")).toBe("2025-01-31");
      expect(oneYearEarlierYMD("2026-12-31")).toBe("2025-12-31");
    });
  });

  describe("getCoverage()", () => {
    it("counts both stored directions as one pair", async () => {
      coverageRows({
        earliest: "2026-01-02",
        latest: "2026-09-16",
        observations: "180",
      });

      const coverage = await service.getCoverage("user-1", "EUR");

      expect(coverage).toEqual({
        from: "EUR",
        to: "PLN",
        earliestDate: "2026-01-02",
        latestDate: "2026-09-16",
        observations: 180,
      });
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("from_currency = $1 AND to_currency = $2");
      expect(sql).toContain("from_currency = $2 AND to_currency = $1");
      // Days, not rows: a fetch is persisted in both directions.
      expect(sql).toContain("COUNT(DISTINCT rate_date)");
      expect(params).toEqual(["EUR", "PLN"]);
    });

    it("reports null bounds and zero observations for a pair with no rows", async () => {
      coverageRows({ earliest: null, latest: null, observations: "0" });

      await expect(service.getCoverage("user-1", "EUR")).resolves.toEqual({
        from: "EUR",
        to: "PLN",
        earliestDate: null,
        latestDate: null,
        observations: 0,
      });
    });

    it("refuses the caller's own reporting currency", async () => {
      await expect(service.getCoverage("user-1", "PLN")).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe("extendHistory()", () => {
    it("asks for the year ending the day before the stored history starts", async () => {
      coverageRows(
        { earliest: "2026-01-02", latest: "2026-09-16", observations: "180" },
        { earliest: "2025-01-02", latest: "2026-09-16", observations: "420" },
      );

      const result = await service.extendHistory("user-1", "EUR");

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledWith(
        "EUR",
        "PLN",
        "2025-01-02",
        "2026-01-01",
      );
      expect(result).toEqual({
        from: "EUR",
        to: "PLN",
        requestedFrom: "2025-01-02",
        requestedTo: "2026-01-01",
        stored: 240,
        earliestDate: "2025-01-02",
        answered: true,
      });
    });

    it("anchors on today when the pair has no rows, so the window ends yesterday", async () => {
      coverageRows(
        { earliest: null, latest: null, observations: "0" },
        { earliest: "2025-09-17", latest: "2026-09-16", observations: "240" },
      );

      const result = await service.extendHistory("user-1", "EUR");

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledWith(
        "EUR",
        "PLN",
        "2025-09-17",
        "2026-09-16",
      );
      expect(result.requestedTo).toBe("2026-09-16");
    });

    it("steps the window over a month end without arriving at day 0", async () => {
      coverageRows(
        { earliest: "2026-03-01", latest: "2026-09-16", observations: "120" },
        { earliest: "2025-03-01", latest: "2026-09-16", observations: "360" },
      );

      await service.extendHistory("user-1", "EUR");

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledWith(
        "EUR",
        "PLN",
        "2025-03-01",
        "2026-02-28",
      );
    });

    it("returns stored 0 with the coverage unchanged when the provider answered with nothing", async () => {
      coverageRows({
        earliest: "2026-01-02",
        latest: "2026-09-16",
        observations: "180",
      });
      exchangeRateService.fillRateWindow.mockResolvedValue({
        stored: 0,
        answered: true,
      });

      const result = await service.extendHistory("user-1", "EUR");

      expect(result.stored).toBe(0);
      expect(result.answered).toBe(true);
      expect(result.earliestDate).toBe("2026-01-02");
      // No second coverage read: nothing was written, so nothing moved.
      expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it("throws 503 when the provider did not answer at all", async () => {
      coverageRows({
        earliest: "2026-01-02",
        latest: "2026-09-16",
        observations: "180",
      });
      exchangeRateService.fillRateWindow.mockResolvedValue({
        stored: 0,
        answered: false,
      });

      await expect(service.extendHistory("user-1", "EUR")).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it("coalesces a double click into one provider call", async () => {
      coverageRows(
        { earliest: "2026-01-02", latest: "2026-09-16", observations: "180" },
        { earliest: "2025-01-02", latest: "2026-09-16", observations: "420" },
      );
      let release: (value: { stored: number; answered: boolean }) => void;
      exchangeRateService.fillRateWindow.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const first = service.extendHistory("user-1", "EUR");
      const second = service.extendHistory("user-1", "EUR");
      release!({ stored: 240, answered: true });
      const [a, b] = await Promise.all([first, second]);

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledTimes(1);
      expect(a).toEqual(b);
    });

    it("lets the next click start a fresh extension once the first settled", async () => {
      coverageRows({
        earliest: "2026-01-02",
        latest: "2026-09-16",
        observations: "180",
      });

      await service.extendHistory("user-1", "EUR");
      await service.extendHistory("user-1", "EUR");

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledTimes(2);
    });

    it("does not leave a failed extension in flight", async () => {
      coverageRows({
        earliest: "2026-01-02",
        latest: "2026-09-16",
        observations: "180",
      });
      exchangeRateService.fillRateWindow.mockResolvedValueOnce({
        stored: 0,
        answered: false,
      });

      await expect(service.extendHistory("user-1", "EUR")).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(
        service.extendHistory("user-1", "EUR"),
      ).resolves.toMatchObject({ stored: 240 });
    });

    it("refuses the caller's own reporting currency before calling the provider", async () => {
      await expect(service.extendHistory("user-1", "PLN")).rejects.toThrow(
        BadRequestException,
      );
      expect(exchangeRateService.fillRateWindow).not.toHaveBeenCalled();
    });
  });
});
