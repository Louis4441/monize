import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  ExchangeRateHistoryService,
  STORED_RATE_ROW_CAP,
} from "./exchange-rate-history.service";
import { ExchangeRateService } from "./exchange-rate.service";
import { roundFxRate } from "../common/fx-entry.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The fill's span ends today, so today has to be a fixture or "which window did
// it ask for" becomes a question about the day the suite runs. Only `todayYMD`
// is replaced; `addDaysYMD` beside it is the real thing.
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

interface CoverageRow {
  earliest: string | null;
  latest: string | null;
  observations: string;
}

interface StoredRow {
  rate_date: string;
  from_currency: string;
  rate: string | null;
  source: string | null;
}

describe("ExchangeRateHistoryService", () => {
  let service: ExchangeRateHistoryService;
  let manager: Record<string, jest.Mock>;
  let dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  /**
   * Answer each of the service's reads by what it asks for, rather than by call
   * order: the fill issues three different queries before it fetches anything,
   * and a positional mock would silently hand one of them another's rows.
   */
  const rowsFor = (answers: {
    firstUse?: string | null;
    coverage?: CoverageRow | CoverageRow[];
    storedDates?: string[];
    listing?: StoredRow[];
  }) => {
    let coverageCall = 0;
    manager.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM accounts a")) {
        return Promise.resolve([{ earliest: answers.firstUse ?? null }]);
      }
      if (sql.includes("COUNT(DISTINCT rate_date)")) {
        const coverage = answers.coverage ?? {
          earliest: null,
          latest: null,
          observations: "0",
        };
        const list = Array.isArray(coverage) ? coverage : [coverage];
        const row = list[Math.min(coverageCall, list.length - 1)];
        coverageCall += 1;
        return Promise.resolve([row]);
      }
      if (sql.includes("SELECT DISTINCT TO_CHAR")) {
        return Promise.resolve(
          (answers.storedDates ?? []).map((rate_date) => ({ rate_date })),
        );
      }
      if (sql.includes("ARRAY_AGG")) {
        return Promise.resolve(answers.listing ?? []);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  };

  /** One window's worth of provider outcome, in the order they are asked for. */
  const providerAnswers = (
    ...outcomes: Array<{ stored: number; answered: boolean }>
  ) => {
    let call = 0;
    exchangeRateService.fillRateWindow.mockImplementation(() => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return Promise.resolve(outcome);
    });
  };

  /** The `[from, to, start, end]` of every provider window asked for. */
  const windowsAsked = () =>
    exchangeRateService.fillRateWindow.mock.calls.map(
      ([, , start, end]: string[]) => [start, end],
    );

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

  describe("getCoverage()", () => {
    it("counts both stored directions as one pair", async () => {
      rowsFor({
        coverage: {
          earliest: "2026-01-02",
          latest: "2026-09-16",
          observations: "180",
        },
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
      // Days, not rows: a pre-collapse date may still be held twice.
      expect(sql).toContain("COUNT(DISTINCT rate_date)");
      expect(params).toEqual(["EUR", "PLN"]);
    });

    it("reports null bounds and zero observations for a pair with no rows", async () => {
      rowsFor({
        coverage: { earliest: null, latest: null, observations: "0" },
      });

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

  describe("getStoredRates()", () => {
    const listingRow = (over: Partial<StoredRow> = {}): StoredRow => ({
      rate_date: "2026-09-16",
      from_currency: "EUR",
      rate: "4.3000000000",
      source: "yahoo_finance",
      ...over,
    });

    it("reads both orientations, one entry per date, newest first", async () => {
      rowsFor({ listing: [listingRow()] });

      await service.getStoredRates("user-1", "EUR");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("from_currency = $1 AND to_currency = $2");
      expect(sql).toContain("from_currency = $2 AND to_currency = $1");
      expect(sql).toContain("GROUP BY rate_date");
      expect(sql).toContain("ORDER BY rate_date DESC");
      expect(sql).toContain("TO_CHAR(rate_date, 'YYYY-MM-DD')");
      // One more than the cap, so truncation is observed rather than assumed.
      expect(params).toEqual(["EUR", "PLN", STORED_RATE_ROW_CAP + 1]);
    });

    it("returns a row stored in the direction asked for unchanged", async () => {
      rowsFor({ listing: [listingRow()] });

      const list = await service.getStoredRates("user-1", "EUR");

      expect(list.from).toBe("EUR");
      expect(list.to).toBe("PLN");
      expect(list.rates).toEqual([
        {
          rateDate: "2026-09-16",
          rate: 4.3,
          source: "yahoo_finance",
          inverted: false,
        },
      ]);
    });

    it("inverts a row stored the other way round, at rate precision", async () => {
      // USD against PLN is stored canonically as PLN->USD (P < U), which is the
      // reverse of what a reader asking about USD wants.
      rowsFor({
        listing: [
          listingRow({ from_currency: "PLN", rate: "0.2500000000" }),
          listingRow({
            rate_date: "2026-09-15",
            from_currency: "PLN",
            rate: "0.7325000000",
          }),
        ],
      });

      const list = await service.getStoredRates("user-1", "USD");

      expect(list.rates[0]).toMatchObject({ rate: 4, inverted: true });
      // Ten decimals, not money's four: 1/0.7325 at four places inverts back to
      // a different rate than the one stored.
      expect(list.rates[1].rate).toBe(roundFxRate(1 / 0.7325));
      expect(list.rates[1].rate).not.toBe(1.3652);
    });

    it("reports a non-positive stored rate as unknown, never as zero", async () => {
      rowsFor({ listing: [listingRow({ rate: "0.0000000000" })] });

      const list = await service.getStoredRates("user-1", "EUR");

      expect(list.rates[0].rate).toBeNull();
    });

    it("carries a row written without a source through as unknown", async () => {
      rowsFor({ listing: [listingRow({ source: null })] });

      const list = await service.getStoredRates("user-1", "EUR");

      expect(list.rates[0].source).toBeNull();
    });

    it("reports truncation and trims to the cap", async () => {
      rowsFor({
        listing: Array.from({ length: STORED_RATE_ROW_CAP + 1 }, (_, i) =>
          listingRow({ rate_date: `2026-09-${String((i % 28) + 1)}` }),
        ),
      });

      const list = await service.getStoredRates("user-1", "EUR");

      expect(list.rates).toHaveLength(STORED_RATE_ROW_CAP);
      expect(list.truncated).toBe(true);
      expect(list.limit).toBe(STORED_RATE_ROW_CAP);
    });

    it("does not report truncation at exactly the cap", async () => {
      rowsFor({
        listing: Array.from({ length: STORED_RATE_ROW_CAP }, (_, i) =>
          listingRow({ rate_date: `2026-09-${String((i % 28) + 1)}` }),
        ),
      });

      const list = await service.getStoredRates("user-1", "EUR");

      expect(list.rates).toHaveLength(STORED_RATE_ROW_CAP);
      expect(list.truncated).toBe(false);
    });

    it("refuses the caller's own reporting currency before reading anything", async () => {
      await expect(service.getStoredRates("user-1", "PLN")).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe("fillRateGaps()", () => {
    it("fetches nothing for a currency none of the caller's data uses", async () => {
      rowsFor({ firstUse: null });

      const result = await service.fillRateGaps("user-1", "EUR");

      expect(result.usedFrom).toBeNull();
      expect(result.windowsPlanned).toBe(0);
      expect(exchangeRateService.fillRateWindow).not.toHaveBeenCalled();
    });

    it("takes the span from the caller's own accounts and securities", async () => {
      rowsFor({ firstUse: "2026-01-01" });

      await service.fillRateGaps("user-1", "EUR");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("FROM accounts a");
      expect(sql).toContain("FROM securities s");
      // Closed accounts and emptied holdings count: reports still cover the
      // years they were open.
      expect(sql).not.toContain("is_closed");
      expect(sql).not.toContain("h.quantity");
      expect(sql).toContain("it.status != 'VOID'");
      expect(params).toEqual(["user-1", "EUR"]);
    });

    it("fetches nothing when every date in the span is already answerable", async () => {
      // One observation a fortnight before the span and one inside it: the
      // carry-forward bound covers everything between them.
      rowsFor({
        firstUse: "2026-09-01",
        storedDates: ["2026-08-20", "2026-09-10"],
      });

      const result = await service.fillRateGaps("user-1", "EUR");

      expect(result.windowsPlanned).toBe(0);
      expect(result.unresolvableDays).toBe(0);
      expect(exchangeRateService.fillRateWindow).not.toHaveBeenCalled();
    });

    it("asks the provider for the span when the pair has nothing stored", async () => {
      rowsFor({
        firstUse: "2026-01-01",
        coverage: [
          { earliest: null, latest: null, observations: "0" },
          {
            earliest: "2025-12-18",
            latest: "2026-09-17",
            observations: "190",
          },
        ],
      });

      const result = await service.fillRateGaps("user-1", "EUR");

      expect(windowsAsked()).toEqual([["2025-12-18", "2026-09-17"]]);
      expect(result.stored).toBe(240);
      expect(result.earliestDate).toBe("2025-12-18");
      expect(result.windowsRemaining).toBe(0);
      expect(result.spanEnd).toBe("2026-09-17");
    });

    it("looks for observations from before the span, which answer its first days", async () => {
      rowsFor({ firstUse: "2026-01-01" });

      await service.fillRateGaps("user-1", "EUR");

      const datesCall = manager.query.mock.calls.find(([sql]: [string]) =>
        sql.includes("SELECT DISTINCT TO_CHAR"),
      );
      // 45 days before the span opens: the oldest observation that could still
      // stand for its first day.
      expect(datesCall[1]).toEqual(["EUR", "PLN", "2025-11-17", "2026-09-17"]);
    });

    it("walks a long span oldest first, a year at a time", async () => {
      rowsFor({ firstUse: "2023-01-01" });

      const result = await service.fillRateGaps("user-1", "EUR");

      const asked = windowsAsked();
      expect(asked).toHaveLength(4);
      expect(asked[0][0]).toBe("2022-12-18");
      expect(asked[asked.length - 1][1]).toBe("2026-09-17");
      // Oldest first, contiguous, and never wider than a year: a deeper request
      // comes back as monthly bars.
      for (let i = 1; i < asked.length; i++) {
        expect(asked[i][0] > asked[i - 1][1]).toBe(true);
      }
      expect(result.windowsFetched).toBe(4);
      expect(result.windowsRemaining).toBe(0);
    });

    it("reports what the provider has, when it answers with nothing", async () => {
      providerAnswers({ stored: 0, answered: true });
      rowsFor({ firstUse: "2026-01-01" });

      const result = await service.fillRateGaps("user-1", "EUR");

      expect(result.stored).toBe(0);
      // The oldest window came back empty, so the pair's history starts after
      // it. Not a failure, and asking again will not change it.
      expect(result.providerHasNothingBefore).toBe("2026-09-18");
    });

    it("does not re-ask for a window the provider already answered with nothing", async () => {
      providerAnswers({ stored: 0, answered: true });
      rowsFor({ firstUse: "2026-01-01" });

      await service.fillRateGaps("user-1", "EUR");
      const second = await service.fillRateGaps("user-1", "EUR");

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledTimes(1);
      expect(second.windowsSkipped).toBe(1);
      expect(second.windowsFetched).toBe(0);
      // Still says where the provider's history starts: the second press knows
      // exactly what the first one learned.
      expect(second.providerHasNothingBefore).toBe("2026-09-18");
    });

    it("raises a 503 when the provider did not answer at all", async () => {
      providerAnswers({ stored: 0, answered: false });
      rowsFor({ firstUse: "2026-01-01" });

      await expect(service.fillRateGaps("user-1", "EUR")).rejects.toThrow(
        ServiceUnavailableException,
      );
      // A window that got no answer is not remembered as empty: a two-minute
      // outage must not read as "this pair has no history".
      await expect(service.fillRateGaps("user-1", "EUR")).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledTimes(2);
    });

    it("reports what it stored even when a later window fails", async () => {
      providerAnswers(
        { stored: 120, answered: true },
        { stored: 0, answered: false },
      );
      rowsFor({ firstUse: "2023-01-01" });

      const result = await service.fillRateGaps("user-1", "EUR");

      expect(result.stored).toBe(120);
      expect(result.windowsUnanswered).toBe(3);
      // A window the provider did not answer is still to do. Dropping it would
      // leave the reader with a success message and a history still missing
      // three years of it.
      expect(result.windowsRemaining).toBe(3);
    });

    it("falls back to the account's own date when it holds no postings", async () => {
      rowsFor({ firstUse: "2026-01-01" });

      await service.fillRateGaps("user-1", "EUR");

      const [sql] = manager.query.mock.calls[0];
      // An account holding an opening balance and nothing else is still
      // reported by net worth over time, so it still dates a use of the
      // currency.
      expect(sql).toContain("a.created_at::DATE");
      expect(sql).toContain("s.created_at::DATE");
    });

    it("does not count a non-positive stored rate as an observation", async () => {
      rowsFor({ firstUse: "2026-01-01" });

      await service.fillRateGaps("user-1", "EUR");

      const datesCall = manager.query.mock.calls.find(([sql]: [string]) =>
        sql.includes("SELECT DISTINCT TO_CHAR"),
      );
      // `resolveFxRate` discards it, so planning around it would leave 45 days
      // looking answerable that no report can convert.
      expect(datesCall[0]).toContain("rate > 0");
    });

    it("stops at the time budget and reports the windows it did not reach", async () => {
      rowsFor({ firstUse: "2023-01-01" });
      const realNow = Date.now();
      const clock = jest
        .spyOn(Date, "now")
        // The deadline is read once, then each window checks it: the second
        // check is already past it, so only one window is fetched.
        .mockReturnValueOnce(realNow)
        .mockReturnValueOnce(realNow)
        .mockReturnValue(realNow + 60_000);

      const result = await service.fillRateGaps("user-1", "EUR");

      expect(result.windowsFetched).toBe(1);
      expect(result.windowsPlanned).toBe(4);
      expect(result.windowsRemaining).toBe(3);
      clock.mockRestore();
    });

    it("coalesces a double-clicked button into one fetch", async () => {
      rowsFor({ firstUse: "2026-01-01" });
      let release: (value: {
        stored: number;
        answered: boolean;
      }) => void = () => {};
      exchangeRateService.fillRateWindow.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const first = service.fillRateGaps("user-1", "EUR");
      const second = service.fillRateGaps("user-1", "EUR");
      release({ stored: 12, answered: true });
      const [a, b] = await Promise.all([first, second]);

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });

    it("does not hand one caller's summary to another", async () => {
      // Two people sharing a reporting currency press at the same moment. The
      // span and the counts come from each one's own data, so the second must
      // not be handed the first's answer.
      rowsFor({ firstUse: "2026-01-01" });
      let release: (value: {
        stored: number;
        answered: boolean;
      }) => void = () => {};
      exchangeRateService.fillRateWindow.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const first = service.fillRateGaps("user-1", "EUR");
      const second = service.fillRateGaps("user-2", "EUR");
      release({ stored: 12, answered: true });
      const [a, b] = await Promise.all([first, second]);

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledTimes(2);
      expect(a).not.toBe(b);
    });

    it("lets the next click fetch again once the last one finished", async () => {
      rowsFor({ firstUse: "2026-01-01" });

      await service.fillRateGaps("user-1", "EUR");
      await service.fillRateGaps("user-1", "EUR");

      expect(exchangeRateService.fillRateWindow).toHaveBeenCalledTimes(2);
    });

    it("refuses the caller's own reporting currency before reading anything", async () => {
      await expect(service.fillRateGaps("user-1", "PLN")).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
      expect(exchangeRateService.fillRateWindow).not.toHaveBeenCalled();
    });
  });
});
