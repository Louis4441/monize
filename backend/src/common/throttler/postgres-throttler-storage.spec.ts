import { DataSource } from "typeorm";

import {
  FAILURE_LOG_INTERVAL_MS,
  PostgresThrottlerStorage,
} from "./postgres-throttler-storage";

/**
 * What a mocked manager can prove about this class, and what it cannot.
 *
 * It can prove the contract with `@nestjs/throttler`: the units (milliseconds
 * in, seconds out), which clock the conversions use, the shape of the statement
 * and its bind parameters, and what happens when the database is gone. It
 * cannot prove that the statement itself counts correctly under two concurrent
 * writers -- that is a property of PostgreSQL, and it is asserted on two real
 * connections in `test/integration/postgres-throttler.integration.spec.ts`
 * (VER-001, `docs/verification-contract.md`).
 */
describe("PostgresThrottlerStorage", () => {
  const NOW = new Date("2026-03-01T12:00:00.000Z");

  let query: jest.Mock;
  let storage: PostgresThrottlerStorage;

  /** One row as the statement returns it, with the database's clock in it. */
  const row = (overrides: Partial<Record<string, unknown>> = {}) => [
    {
      hits: 1,
      window_expires_at: new Date(NOW.getTime() + 60_000),
      blocked_until: null,
      db_now: NOW,
      ...overrides,
    },
  ];

  beforeEach(() => {
    query = jest.fn().mockResolvedValue(row());
    storage = new PostgresThrottlerStorage({
      transaction: (fn: unknown) =>
        (fn as (m: { query: jest.Mock }) => unknown)({ query }),
      query,
    } as unknown as DataSource);
  });

  const sql = () => (query.mock.calls[0]?.[0] as string) ?? "";
  const params = () => (query.mock.calls[0]?.[1] as unknown[]) ?? [];

  describe("the statement", () => {
    it("binds the throttler name, the key and both durations as milliseconds", async () => {
      await storage.increment("key-hash", 60_000, 100, 30_000, "default");

      // The library hands milliseconds; a storage that treated them as seconds
      // would enforce a one-minute window for a full minute of every hour.
      expect(params()).toEqual(["default", "key-hash", 60_000, 100, 30_000]);
    });

    it("rounds a fractional duration rather than passing it to an interval", async () => {
      await storage.increment("k", 1500.7, 5, 900.2, "default");

      expect(params()[2]).toBe(1501);
      expect(params()[4]).toBe(900);
    });

    it("is a single upsert keyed by throttler name and key", async () => {
      await storage.increment("k", 60_000, 100, 0, "default");

      // One statement is the whole mechanism: a read then a write lets two
      // replicas each see "4 of 5" and both allow the fifth.
      expect(query).toHaveBeenCalledTimes(1);
      expect(sql()).toContain("INSERT INTO http_throttle_counters");
      expect(sql()).toContain("ON CONFLICT (name, key) DO UPDATE");
      expect(sql()).toContain("RETURNING");
    });

    it("reads the clock from the database, not from this process", async () => {
      // Two replicas whose clocks differ by a second must not disagree about
      // whether a window has passed, so every comparison and every conversion
      // is against a timestamp the database stamped in the same statement.
      expect(sql()).not.toContain("$6");
      await storage.increment("k", 60_000, 100, 0, "default");
      expect(sql()).toContain("CURRENT_TIMESTAMP AS db_now");
      expect(sql()).not.toMatch(/\bnow\(\)/);
    });
  });

  describe("the record it returns", () => {
    it("reports the hit count and the window in whole seconds", async () => {
      query.mockResolvedValue(
        row({ hits: 7, window_expires_at: new Date(NOW.getTime() + 42_000) }),
      );

      const record = await storage.increment("k", 60_000, 100, 0, "default");

      expect(record).toEqual({
        totalHits: 7,
        timeToExpire: 42,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it("rounds a partial second up, as the library's own storage does", async () => {
      query.mockResolvedValue(
        row({ window_expires_at: new Date(NOW.getTime() + 41_001) }),
      );

      const record = await storage.increment("k", 60_000, 100, 0, "default");

      // Math.ceil, so a Retry-After never tells a client to come back before
      // the window has actually passed.
      expect(record.timeToExpire).toBe(42);
    });

    it("counts a hit as blocked while the block is in the future", async () => {
      query.mockResolvedValue(
        row({ hits: 101, blocked_until: new Date(NOW.getTime() + 30_000) }),
      );

      const record = await storage.increment("k", 60_000, 100, 30_000, "x");

      expect(record.isBlocked).toBe(true);
      expect(record.timeToBlockExpire).toBe(30);
    });

    it("is not blocked by a block the database has already passed", async () => {
      // The statement clears a lapsed block, but a row read in the same
      // instant it lapses must not be reported as blocked either.
      query.mockResolvedValue(
        row({ blocked_until: new Date(NOW.getTime() - 1) }),
      );

      const record = await storage.increment("k", 60_000, 100, 30_000, "x");

      expect(record.isBlocked).toBe(false);
      expect(record.timeToBlockExpire).toBe(0);
    });

    it("parses timestamps the driver hands back as strings", async () => {
      // A raw query can return either, depending on the column and the parser.
      query.mockResolvedValue(
        row({
          hits: "3",
          window_expires_at: new Date(NOW.getTime() + 10_000).toISOString(),
          blocked_until: new Date(NOW.getTime() + 5_000).toISOString(),
          db_now: NOW.toISOString(),
        }),
      );

      const record = await storage.increment("k", 60_000, 1, 5_000, "x");

      expect(record).toEqual({
        totalHits: 3,
        timeToExpire: 10,
        isBlocked: true,
        timeToBlockExpire: 5,
      });
    });
  });

  describe("when the database is unreachable", () => {
    let error: jest.SpyInstance;

    beforeEach(() => {
      query.mockRejectedValue(new Error("connection terminated"));
      error = jest
        .spyOn(
          (storage as unknown as { logger: { error: (m: string) => void } })
            .logger,
          "error",
        )
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      error.mockRestore();
      jest.useRealTimers();
    });

    it("fails open rather than refusing the request", async () => {
      // A closed throttler takes the whole API down with the database, before
      // any handler runs. What is lost is one window's leniency on routes whose
      // real refusal is a row elsewhere (auth_attempt_counters).
      const record = await storage.increment("k", 60_000, 100, 0, "default");

      expect(record).toEqual({
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it("logs once a minute, not once a request", async () => {
      jest.useFakeTimers().setSystemTime(NOW);

      await storage.increment("k", 60_000, 100, 0, "default");
      await storage.increment("k", 60_000, 100, 0, "default");
      await storage.increment("k", 60_000, 100, 0, "default");

      expect(error).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date(NOW.getTime() + FAILURE_LOG_INTERVAL_MS));
      await storage.increment("k", 60_000, 100, 0, "default");

      expect(error).toHaveBeenCalledTimes(2);
    });

    it("names the cause, so the log says which dependency went", async () => {
      await storage.increment("k", 60_000, 100, 0, "default");

      expect(error.mock.calls[0][0]).toContain("connection terminated");
      expect(error.mock.calls[0][0]).toContain("failing");
    });
  });
});
