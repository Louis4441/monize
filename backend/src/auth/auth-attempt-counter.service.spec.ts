import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { AuthAttemptCounterService } from "./auth-attempt-counter.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { runOutsideActiveScopedManager } from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("AuthAttemptCounterService", () => {
  let service: AuthAttemptCounterService;
  let manager: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  beforeEach(async () => {
    const scoped = createScopedDbMocks([]);
    manager = scoped.manager as Record<string, jest.Mock>;
    dataSource = scoped.dataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthAttemptCounterService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(AuthAttemptCounterService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("increment", () => {
    it("counts in one statement and returns what the database wrote", async () => {
      const windowExpiresAt = new Date("2026-01-01T12:05:00.000Z");
      manager.query.mockResolvedValue([
        { count: 3, window_expires_at: windowExpiresAt },
      ]);

      const result = await service.increment("2fa-user", "user-1", 300_000);

      expect(result).toEqual({ count: 3, windowExpiresAt });
      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      // One INSERT ... ON CONFLICT DO UPDATE, so the count a caller compares
      // against its threshold is the count the database serialized.
      expect(sql).toContain("INSERT INTO auth_attempt_counters");
      expect(sql).toContain("ON CONFLICT (scope, key) DO UPDATE");
      expect(sql).toContain("RETURNING");
      expect(params).toEqual(["2fa-user", "user-1", 300_000]);
    });

    it("compares the window against the database clock, never this process's", async () => {
      manager.query.mockResolvedValue([
        { count: 1, window_expires_at: new Date() },
      ]);

      await service.increment("2fa-user", "user-1", 300_000);

      const [sql] = manager.query.mock.calls[0];
      expect(sql).toContain("CURRENT_TIMESTAMP");
      expect(sql).not.toMatch(/\$\d::timestamptz/);
    });

    it("coerces the driver's string count and timestamp", async () => {
      manager.query.mockResolvedValue([
        { count: "7", window_expires_at: "2026-01-01T12:05:00.000Z" },
      ]);

      const result = await service.increment("2fa-token", "hash", 1000);

      expect(result.count).toBe(7);
      expect(result.windowExpiresAt).toBeInstanceOf(Date);
      expect(result.windowExpiresAt.toISOString()).toBe(
        "2026-01-01T12:05:00.000Z",
      );
    });

    // A failure counter written inside the transaction that refuses the request
    // rolls back with the refusal, and the limiter counts nothing.
    it("runs outside the caller's transaction so the count survives the refusal", async () => {
      manager.query.mockResolvedValue([
        { count: 1, window_expires_at: new Date() },
      ]);

      await service.increment("2fa-user", "user-1", 1000);

      expect(runOutsideActiveScopedManager).toHaveBeenCalledTimes(1);
    });
  });

  describe("peek", () => {
    it("ignores a row whose window has passed", async () => {
      manager.query.mockResolvedValue([]);

      await expect(service.peek("step-up", "user-1:delete")).resolves.toBe(0);
      const [sql] = manager.query.mock.calls[0];
      expect(sql).toContain("window_expires_at >= CURRENT_TIMESTAMP");
    });

    it("returns the stored count inside the window", async () => {
      manager.query.mockResolvedValue([{ count: "2" }]);

      await expect(service.peek("step-up", "user-1:delete")).resolves.toBe(2);
    });

    it("joins the caller's transaction", async () => {
      manager.query.mockResolvedValue([]);

      await service.peek("step-up", "user-1:delete");

      expect(runOutsideActiveScopedManager).not.toHaveBeenCalled();
    });
  });

  describe("reset", () => {
    it("deletes the one row", async () => {
      manager.query.mockResolvedValue([[], 1]);

      await service.reset("forgot-password", "email-hash");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("DELETE FROM auth_attempt_counters");
      expect(params).toEqual(["forgot-password", "email-hash"]);
    });
  });
});
