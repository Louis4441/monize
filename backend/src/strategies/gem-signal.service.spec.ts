import { GemSignalService, GEM_HISTORY_PERIODS } from "./gem-signal.service";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemStrategyAsset } from "./entities/gem-strategy-asset.entity";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const userId = "user-1";

const strategy = (overrides: Partial<GemStrategy> = {}): GemStrategy =>
  ({
    id: "strategy-1",
    userId,
    accountId: "acct-1",
    cadence: "MONTHLY",
    lookbackMonths: 12,
    taxRatePercent: 19,
    commissionAmount: 29.9,
    rulesSourceUrl: null,
    rulesSourceLabel: null,
    ...overrides,
  }) as GemStrategy;

const assets = (): GemStrategyAsset[] =>
  [
    { role: "US_EQUITY", securityId: "sec-spy" },
    { role: "EX_US_EQUITY", securityId: "sec-ewa" },
    { role: "EM_EQUITY", securityId: "sec-emim" },
    { role: "SAFE", securityId: "sec-ief" },
  ] as GemStrategyAsset[];

/** Straight-line price series so momentum per role is predictable. */
function seriesFor(growthPercent: number) {
  const points: Array<{ date: string; close: number }> = [];
  for (let month = 0; month <= 40; month += 1) {
    const date = new Date(Date.UTC(2022, month, 28));
    points.push({
      date: date.toISOString().slice(0, 10),
      close: 100 * (1 + (growthPercent / 100) * (month / 12)),
    });
  }
  return points;
}

describe("GemSignalService", () => {
  let service: GemSignalService;
  let manager: ManagerMock;
  let signalRepo: Record<string, jest.Mock>;
  /** Rows the mocked insert reports back; null means "the insert won". */
  let insertedRows: Array<Record<string, unknown>> | null;
  /** Every row the loop managed to insert, in order. */
  let savedSignals: Array<Record<string, unknown>>;
  let priceService: {
    loadSeries: jest.Mock;
    earliestPriceDates: jest.Mock;
  };

  beforeEach(() => {
    // Inserting a signal goes through an INSERT ... ON CONFLICT DO NOTHING,
    // because a plain save() inside the transaction would abort it on a
    // concurrent duplicate. `insertedRows` is what the builder pretends the
    // database returned: an empty array stands for "someone else got there
    // first" and is how the concurrency case is exercised.
    insertedRows = null;
    savedSignals = [];
    signalRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((row) => ({ ...row })),
      save: jest.fn((row) =>
        Promise.resolve({ id: `sig-${row.evaluatedOn}`, ...row }),
      ),
      createQueryBuilder: jest.fn(() => {
        let pending: Record<string, unknown> = {};
        const builder = {
          insert: () => builder,
          values: (row: Record<string, unknown>) => {
            pending = row;
            return builder;
          },
          orIgnore: () => builder,
          returning: () => builder,
          execute: jest.fn(async () => {
            const rows = insertedRows ?? [
              { id: `sig-${pending.evaluatedOn as string}`, ...pending },
            ];
            savedSignals.push(...rows);
            return { generatedMaps: rows, raw: rows, identifiers: rows };
          }),
        };
        return builder;
      }),
    };
    const mocks = createScopedDbMocks([[GemStrategySignal, signalRepo]]);
    manager = mocks.manager;
    priceService = {
      loadSeries: jest.fn().mockResolvedValue(
        new Map([
          ["sec-spy", seriesFor(15)],
          ["sec-ewa", seriesFor(8)],
          ["sec-emim", seriesFor(30)],
          ["sec-ief", seriesFor(4)],
        ]),
      ),
      // The fixtures' series start in January 2022, well before every period
      // the tests evaluate, so nothing is bounded out by default.
      earliestPriceDates: jest.fn().mockResolvedValue(
        new Map([
          ["sec-spy", "2022-01-28"],
          ["sec-ief", "2022-01-28"],
        ]),
      ),
    };
    service = new GemSignalService(
      mocks.dataSource as never,
      priceService as never,
    );
  });

  describe("materialize", () => {
    it("evaluates and stores every missing period, newest first", async () => {
      const inserted = savedSignals;
      signalRepo.find
        .mockResolvedValueOnce([]) // stored history: empty
        .mockResolvedValueOnce([{ id: "sig-latest" } as GemStrategySignal]);

      const signals = await service.materialize(
        userId,
        strategy(),
        assets(),
        "2025-08-14",
      );

      expect(inserted).toHaveLength(GEM_HISTORY_PERIODS);
      // Strongest momentum wins while equities beat the safe asset.
      expect(inserted[0]).toMatchObject({
        state: "RISK_ON",
        targetRole: "EM_EQUITY",
        targetSecurityId: "sec-emim",
        previousRole: null,
        executed: false,
      });
      // Each later period knows what the previous one held.
      expect(inserted[1]).toMatchObject({ previousRole: "EM_EQUITY" });
      expect(signals).toEqual([{ id: "sig-latest" }]);
    });

    it("skips a period whose absolute test cannot be run", async () => {
      priceService.loadSeries.mockResolvedValue(
        new Map([["sec-spy", seriesFor(15)]]), // no safe-asset prices
      );
      await service.materialize(userId, strategy(), assets(), "2025-08-14");
      expect(signalRepo.save).not.toHaveBeenCalled();
    });

    it("does not re-evaluate a period that is already stored", async () => {
      signalRepo.find.mockResolvedValue([
        {
          id: "sig-1",
          evaluatedOn: "2025-07-31",
          targetRole: "EM_EQUITY",
        } as GemStrategySignal,
      ]);

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      const stored = signalRepo.save.mock.calls.map(
        ([row]) => row.evaluatedOn as string,
      );
      expect(stored).not.toContain("2025-07-31");
    });

    it("returns the stored history untouched when no role has an instrument", async () => {
      const stored = [{ id: "sig-1" } as GemStrategySignal];
      signalRepo.find.mockResolvedValue(stored);
      const result = await service.materialize(
        userId,
        strategy(),
        [{ role: "SAFE", securityId: null }] as GemStrategyAsset[],
        "2025-08-14",
      );
      expect(result).toBe(stored);
      expect(priceService.loadSeries).not.toHaveBeenCalled();
    });

    it("does not re-read prices for periods the history cannot reach", async () => {
      // Instruments listed this year against a strategy whose calendar goes
      // back two: every one of those older periods evaluates to nothing, and
      // re-reading a year of closes to rediscover that on every report load is
      // what this bound removes.
      priceService.earliestPriceDates.mockResolvedValue(
        new Map([
          ["sec-spy", "2030-01-02"],
          ["sec-ief", "2030-01-02"],
        ]),
      );
      const stored = [{ id: "sig-1" } as GemStrategySignal];
      signalRepo.find.mockResolvedValue(stored);

      const result = await service.materialize(
        userId,
        strategy(),
        assets(),
        "2025-08-14",
      );

      expect(result).toBe(stored);
      expect(priceService.loadSeries).not.toHaveBeenCalled();
    });

    it("evaluates nothing when a required leg has never been priced", async () => {
      // The absolute test needs both the US equity leg and the benchmark, so
      // one of them missing settles it without reading any series.
      priceService.earliestPriceDates.mockResolvedValue(
        new Map([["sec-spy", "2022-01-28"]]),
      );
      await service.materialize(userId, strategy(), assets(), "2025-08-14");
      expect(priceService.loadSeries).not.toHaveBeenCalled();
    });

    it("evaluates the periods the history does reach", async () => {
      // A first close halfway through the calendar bounds out the older
      // periods and keeps the rest, rather than giving up on the strategy.
      priceService.earliestPriceDates.mockResolvedValue(
        new Map([
          ["sec-spy", "2023-08-31"],
          ["sec-ief", "2023-08-31"],
        ]),
      );

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      expect(priceService.loadSeries).toHaveBeenCalled();
      expect(savedSignals.length).toBeGreaterThan(0);
      expect(savedSignals.length).toBeLessThan(GEM_HISTORY_PERIODS);
      // Every stored period's window opens at or after the first close.
      for (const signal of savedSignals) {
        expect(String(signal.evaluatedOn) >= "2024-08-01").toBe(true);
      }
    });

    it("tolerates a concurrent insert of the same period", async () => {
      signalRepo.save.mockRejectedValue({ code: "23505" });
      await expect(
        service.materialize(userId, strategy(), assets(), "2025-08-14"),
      ).resolves.toEqual([]);
    });

    it("propagates a genuine database failure", async () => {
      signalRepo.createQueryBuilder.mockImplementation(() => {
        const builder = {
          insert: () => builder,
          values: () => builder,
          orIgnore: () => builder,
          returning: () => builder,
          execute: () => Promise.reject(new Error("connection lost")),
        };
        return builder;
      });
      await expect(
        service.materialize(userId, strategy(), assets(), "2025-08-14"),
      ).rejects.toThrow("connection lost");
    });

    it("loads prices from one lookback window before the oldest period", async () => {
      await service.materialize(userId, strategy(), assets(), "2025-08-14");
      const [securityIds, from] = priceService.loadSeries.mock.calls[0];
      expect(securityIds).toHaveLength(4);
      // 24 monthly periods back from 2025-07-31 is 2023-08-31, minus 12 months
      // is 2022-08-31, minus the two-week lead the momentum base needs.
      expect(from).toBe("2022-08-17");
    });

    it("still evaluates when the window start is not a trading day", async () => {
      // Friday-only closes, and a mock that honours the requested start date:
      // the momentum base is the last close at or before the window start, so
      // a window starting on a non-trading day only resolves if the query
      // reaches back past it.
      const fridays = (growthPercent: number) => {
        const points: Array<{ date: string; close: number }> = [];
        const cursor = new Date(Date.UTC(2022, 0, 7));
        for (let week = 0; week <= 260; week += 1) {
          points.push({
            date: cursor.toISOString().slice(0, 10),
            close: 100 * (1 + (growthPercent / 100) * (week / 52)),
          });
          cursor.setUTCDate(cursor.getUTCDate() + 7);
        }
        return points;
      };
      priceService.loadSeries.mockImplementation((_ids, from: string) =>
        Promise.resolve(
          new Map([
            ["sec-spy", fridays(15).filter((p) => p.date >= from)],
            ["sec-ewa", fridays(8).filter((p) => p.date >= from)],
            ["sec-emim", fridays(30).filter((p) => p.date >= from)],
            ["sec-ief", fridays(4).filter((p) => p.date >= from)],
          ]),
        ),
      );
      const inserted = savedSignals;

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      // 2023-08-31 minus 12 months is a Wednesday; without the lead there is
      // no close on or before it and every period would be skipped.
      expect(inserted).toHaveLength(GEM_HISTORY_PERIODS);
      expect(inserted[0].momentum).toMatchObject({
        US_EQUITY: expect.any(Number),
      });
    });
  });

  describe("currentSignal", () => {
    it("picks the signal governing the period the date falls in", () => {
      const signals = [
        { evaluatedOn: "2025-07-31" },
        { evaluatedOn: "2025-06-30" },
      ] as GemStrategySignal[];
      expect(
        service.currentSignal(signals, strategy(), "2025-08-14")?.evaluatedOn,
      ).toBe("2025-07-31");
    });

    it("is null when the current period was never evaluated", () => {
      const signals = [{ evaluatedOn: "2025-06-30" }] as GemStrategySignal[];
      expect(
        service.currentSignal(signals, strategy(), "2025-08-14"),
      ).toBeNull();
    });
  });

  describe("markExecuted", () => {
    it("stamps the signal as executed", async () => {
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        executed: false,
      } as GemStrategySignal);

      await expect(service.markExecuted(userId, "sig-1")).resolves.toBe(true);
      const [saved] = signalRepo.save.mock.calls[0];
      expect(saved.executed).toBe(true);
      expect(saved.executedAt).toBeInstanceOf(Date);
    });

    it("is idempotent for an already executed signal", async () => {
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        executed: true,
      } as GemStrategySignal);
      await expect(service.markExecuted(userId, "sig-1")).resolves.toBe(true);
      expect(signalRepo.save).not.toHaveBeenCalled();
    });

    it("reports an unknown signal", async () => {
      signalRepo.findOne.mockResolvedValue(null);
      await expect(service.markExecuted(userId, "sig-x")).resolves.toBe(false);
    });

    it("scopes the lookup to the caller", async () => {
      signalRepo.findOne.mockResolvedValue(null);
      await service.markExecuted(userId, "sig-1");
      expect(signalRepo.findOne).toHaveBeenCalledWith({
        where: { id: "sig-1", userId },
      });
      expect(manager.getRepository).toHaveBeenCalledWith(GemStrategySignal);
    });
  });
});
