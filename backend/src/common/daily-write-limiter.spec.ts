import { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import {
  AuthAttemptCounterMock,
  createAuthAttemptCounterMock,
} from "../test-helpers/auth-attempt-counter-testing";
import {
  AI_WRITE_SCOPE,
  DailyWriteLimiter,
  MCP_WRITE_SCOPE,
  msUntilNextUtcMidnight,
} from "./daily-write-limiter";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("msUntilNextUtcMidnight", () => {
  it("is half a second at 23:59:59.500Z", () => {
    expect(msUntilNextUtcMidnight(new Date("2026-03-14T23:59:59.500Z"))).toBe(
      500,
    );
  });

  // Midnight is the first instant of a day, so the window a write at midnight
  // opens is the whole of that day -- never a zero-length window that the
  // counter would treat as already expired.
  it("is a whole day at exactly midnight", () => {
    expect(msUntilNextUtcMidnight(new Date("2026-03-15T00:00:00.000Z"))).toBe(
      DAY_MS,
    );
  });

  it("is twelve hours at noon UTC", () => {
    expect(msUntilNextUtcMidnight(new Date("2026-03-15T12:00:00.000Z"))).toBe(
      DAY_MS / 2,
    );
  });

  it("crosses a month and a year end", () => {
    expect(msUntilNextUtcMidnight(new Date("2026-12-31T23:00:00.000Z"))).toBe(
      60 * 60 * 1000,
    );
    expect(msUntilNextUtcMidnight(new Date("2028-02-28T18:00:00.000Z"))).toBe(
      6 * 60 * 60 * 1000,
    );
  });

  // The day is UTC's, whatever offset the instant was written with.
  it("ignores the offset the instant was written in", () => {
    expect(
      msUntilNextUtcMidnight(new Date("2026-03-15T20:00:00.000-05:00")),
    ).toBe(DAY_MS - 60 * 60 * 1000);
  });
});

describe("DailyWriteLimiter", () => {
  let counters: AuthAttemptCounterMock;
  let limiter: DailyWriteLimiter;

  beforeEach(() => {
    counters = createAuthAttemptCounterMock();
    limiter = new DailyWriteLimiter(
      counters as unknown as AuthAttemptCounterService,
      "test-scope",
      3,
    );
  });

  it("names the two surfaces' scopes", () => {
    expect(AI_WRITE_SCOPE).toBe("ai-write");
    expect(MCP_WRITE_SCOPE).toBe("mcp-write");
  });

  describe("checkLimit()", () => {
    it("reads the count for its scope and the user", async () => {
      await limiter.checkLimit("user-1");
      expect(counters.peek).toHaveBeenCalledWith("test-scope", "user-1");
    });

    it("allows below the limit", async () => {
      await limiter.record("user-1", "t", 2);
      await expect(limiter.checkLimit("user-1")).resolves.toEqual({
        allowed: true,
        currentCount: 2,
        limit: 3,
      });
    });

    it("refuses at the limit", async () => {
      await limiter.record("user-1", "t", 3);
      await expect(limiter.checkLimit("user-1")).resolves.toEqual({
        allowed: false,
        currentCount: 3,
        limit: 3,
      });
    });

    it("refuses over the limit", async () => {
      await limiter.record("user-1", "t", 5);
      await expect(limiter.checkLimit("user-1")).resolves.toEqual({
        allowed: false,
        currentCount: 5,
        limit: 3,
      });
    });

    it("keeps each scope's count separate for one user", async () => {
      const other = new DailyWriteLimiter(
        counters as unknown as AuthAttemptCounterService,
        "other-scope",
        3,
      );
      await limiter.record("user-1", "t", 3);
      expect((await other.checkLimit("user-1")).currentCount).toBe(0);
    });
  });

  describe("record()", () => {
    it("increments once by default, on a fixed window ending at UTC midnight", async () => {
      jest.useFakeTimers({ now: new Date("2026-03-15T22:00:00.000Z") });
      try {
        await limiter.record("user-1", "create_payee");
      } finally {
        jest.useRealTimers();
      }
      expect(counters.increment).toHaveBeenCalledTimes(1);
      expect(counters.increment).toHaveBeenCalledWith(
        "test-scope",
        "user-1",
        2 * 60 * 60 * 1000,
        "fixed",
      );
    });

    it("increments `count` times", async () => {
      await limiter.record("user-1", "create_transaction", 4);
      expect(counters.increment).toHaveBeenCalledTimes(4);
      expect((await limiter.checkLimit("user-1")).currentCount).toBe(4);
    });

    it("increments nothing for a count of zero", async () => {
      await limiter.record("user-1", "create_transaction", 0);
      expect(counters.increment).not.toHaveBeenCalled();
    });

    // Recording follows a committed write; a rejection here would report a
    // write the user now has as a failure the caller might retry.
    it("does not reject when the counter cannot be written", async () => {
      counters.increment.mockRejectedValue(new Error("pool exhausted"));
      await expect(
        limiter.record("user-1", "create_transaction", 2),
      ).resolves.toBeUndefined();
    });
  });
});
