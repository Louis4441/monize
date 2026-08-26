import { Logger } from "@nestjs/common";
import { ProviderHealthService } from "./provider-health.service";
import { FAILURE_THRESHOLD, OPEN_WINDOW_MS } from "./provider-circuit";
import { ProviderUnavailableError } from "./provider-unavailable.error";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () => {
  const actual = jest
    .requireActual("../test-helpers/scoped-db-testing")
    .scopedDbMockModule();
  return actual;
});

jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
}));

const PROVIDER = "yahoo_finance";

/** A DNS failure in the exact shape undici produces. */
function transportError(code = "EAI_AGAIN"): Error {
  const error = new TypeError("fetch failed");
  Object.assign(error, {
    cause: Object.assign(
      new Error(`getaddrinfo ${code} query1.finance.yahoo.com`),
      {
        code,
        syscall: "getaddrinfo",
        hostname: "query1.finance.yahoo.com",
      },
    ),
  });
  return error;
}

/** A logger whose calls the test can read. */
function fakeLogger(): jest.Mocked<
  Pick<Logger, "warn" | "log" | "error" | "debug">
> {
  return {
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as never;
}

describe("ProviderHealthService", () => {
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let service: ProviderHealthService;
  let now: number;
  let serviceLogger: jest.Mocked<Pick<Logger, "warn" | "log" | "error">>;

  const statements = (): string[] =>
    manager.query.mock.calls.map((call) => String(call[0]));

  const advance = (ms: number) => {
    now += ms;
  };

  /** Drive the breaker open the way an outage does. */
  const driveOpen = () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      service.recordFailure(PROVIDER, transportError());
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    manager.query.mockResolvedValue([]);
    now = 1_700_000_000_000;
    service = new ProviderHealthService(dataSource as never, () => now);
    serviceLogger = fakeLogger() as never;
    (service as unknown as { logger: unknown }).logger = serviceLogger;
  });

  describe("assertAvailable", () => {
    it("allows calls while the provider answers", () => {
      expect(() => service.assertAvailable(PROVIDER)).not.toThrow();
    });

    it("refuses calls once the breaker opens, without touching the network", () => {
      driveOpen();
      expect(() => service.assertAvailable(PROVIDER)).toThrow(
        ProviderUnavailableError,
      );
    });

    it("names the provider and the wait in the refusal", () => {
      driveOpen();
      advance(15_000);
      let thrown: unknown;
      try {
        service.assertAvailable(PROVIDER);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderUnavailableError);
      const error = thrown as ProviderUnavailableError;
      expect(error.provider).toBe("Yahoo Finance");
      expect(error.retryAfterMs).toBe(OPEN_WINDOW_MS - 15_000);
      expect(error.message).toContain("EAI_AGAIN");
    });

    it("keeps one provider's outage out of the other's way", () => {
      driveOpen();
      expect(() => service.assertAvailable("msn_finance")).not.toThrow();
    });
  });

  describe("recordFailure", () => {
    it("ignores a failure that proves nothing about the provider", () => {
      // The server answered and sent something unparseable: this request's
      // problem. Counting it would take the provider down for everyone.
      for (let i = 0; i < FAILURE_THRESHOLD * 3; i++) {
        service.recordFailure(PROVIDER, new SyntaxError("Unexpected token <"));
      }
      expect(() => service.assertAvailable(PROVIDER)).not.toThrow();
    });

    it("ignores its own refusal, so a refused call cannot deepen the outage", () => {
      driveOpen();
      const refusal = new ProviderUnavailableError("Yahoo Finance", 1000, null);
      service.recordFailure(PROVIDER, refusal);
      expect(service.snapshot(PROVIDER).consecutiveFailures).toBe(
        FAILURE_THRESHOLD,
      );
    });

    it("logs the outage once, with the cause, when the breaker opens", () => {
      driveOpen();
      expect(serviceLogger.error).toHaveBeenCalledTimes(1);
      const line = String(serviceLogger.error.mock.calls[0][0]);
      expect(line).toContain("Yahoo Finance");
      expect(line).toContain("EAI_AGAIN");
      expect(line).toContain(`${FAILURE_THRESHOLD} consecutive`);
    });

    it("writes the outage to provider_health so it survives the restart", () => {
      driveOpen();
      const insert = statements().find((sql) =>
        sql.includes("INSERT INTO provider_health"),
      );
      expect(insert).toBeDefined();
      const params = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO provider_health"),
      )?.[1] as unknown[];
      expect(params[0]).toBe(PROVIDER);
      expect(params[1]).toBe("down");
      // The episode start, not "now": the alert gate reads it.
      expect((params[3] as Date).getTime()).toBe(1_700_000_000_000);
      expect(String(params[5])).toContain("EAI_AGAIN");
    });

    it("preserves an already-recorded episode start in SQL, not in memory", () => {
      driveOpen();
      const insert = statements().find((sql) =>
        sql.includes("INSERT INTO provider_health"),
      ) as string;
      // A restarted container has a fresh in-memory failingSince, so the
      // clock the alert reads can only be protected by the write itself.
      expect(insert).toContain("provider_health.state = 'down'");
      expect(insert).toContain("THEN provider_health.outage_started_at");
    });

    it("does not write a row for a failure run below the threshold", () => {
      service.recordFailure(PROVIDER, transportError());
      expect(
        statements().filter((sql) => sql.includes("provider_health")),
      ).toHaveLength(0);
    });

    it("does not write on every failure while it stays down", () => {
      driveOpen();
      // Twenty minutes of probes failing, one every ten seconds.
      for (let i = 0; i < 120; i++) {
        advance(10_000);
        service.recordFailure(PROVIDER, transportError());
      }
      // One write for the transition, then a heartbeat every five minutes --
      // not one per failed symbol, which is the flood in another form.
      const writes = statements().filter((sql) =>
        sql.includes("INSERT INTO provider_health"),
      );
      expect(writes.length).toBeGreaterThan(1);
      expect(writes.length).toBeLessThanOrEqual(5);
    });

    it("never lets a failed health write break the caller", async () => {
      manager.query.mockRejectedValue(new Error("database is starting up"));
      expect(() => driveOpen()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(serviceLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not record Yahoo Finance health"),
      );
    });
  });

  describe("recordSuccess", () => {
    it("says so once when the provider comes back, with what was refused", () => {
      driveOpen();
      service.assertAvailable.bind(service);
      for (let i = 0; i < 3; i++) {
        try {
          service.assertAvailable(PROVIDER);
        } catch {
          // refused, as expected
        }
      }
      advance(OPEN_WINDOW_MS + 1);
      service.assertAvailable(PROVIDER);
      service.recordSuccess(PROVIDER);

      expect(serviceLogger.log).toHaveBeenCalledTimes(1);
      const line = String(serviceLogger.log.mock.calls[0][0]);
      expect(line).toContain("Yahoo Finance is answering again");
      expect(line).toContain("3 call(s) were refused");
      const healthWrites = manager.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO provider_health"),
      );
      const params = healthWrites[healthWrites.length - 1][1] as unknown[];
      expect(params[1]).toBe("up");
    });

    it("is silent for a success that follows a success", () => {
      service.recordSuccess(PROVIDER);
      service.recordSuccess(PROVIDER);
      expect(serviceLogger.log).not.toHaveBeenCalled();
      expect(
        statements().filter((sql) => sql.includes("provider_health")),
      ).toHaveLength(0);
    });
  });

  describe("logFailure", () => {
    it("carries the cause, the context and the provider on the first line", () => {
      const logger = fakeLogger();
      service.logFailure(
        logger as never,
        PROVIDER,
        "historical prices for ^RUT",
        transportError(),
      );
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const line = String(logger.warn.mock.calls[0][0]);
      expect(line).toContain("Yahoo Finance");
      expect(line).toContain("historical prices for ^RUT");
      expect(line).toContain("EAI_AGAIN");
      expect(line).toContain("hostname=query1.finance.yahoo.com");
    });

    it("collapses a flood into one line a minute, and counts the rest", () => {
      const logger = fakeLogger();
      // 264 chunk fetches failing inside a few seconds -- the bootstrap
      // market-index refresh in issue #1265.
      for (let i = 0; i < 264; i++) {
        service.logFailure(
          logger as never,
          PROVIDER,
          `chunk ${i}`,
          transportError(),
        );
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);

      advance(60_000);
      service.logFailure(
        logger as never,
        PROVIDER,
        "chunk again",
        transportError(),
      );
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(String(logger.warn.mock.calls[1][0])).toContain(
        "263 similar failure(s) suppressed",
      );
    });

    it("prints nothing at all for a call the breaker refused", () => {
      const logger = fakeLogger();
      const refusal = new ProviderUnavailableError(
        "Yahoo Finance",
        30_000,
        "EAI_AGAIN",
      );
      for (let i = 0; i < 50; i++) {
        service.logFailure(logger as never, PROVIDER, `chunk ${i}`, refusal);
      }
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("starts fresh after a recovery rather than reporting a stale count", () => {
      const logger = fakeLogger();
      service.logFailure(logger as never, PROVIDER, "chunk", transportError());
      service.logFailure(logger as never, PROVIDER, "chunk", transportError());
      service.recordSuccess(PROVIDER);
      advance(1_000);
      service.logFailure(logger as never, PROVIDER, "chunk", transportError());
      const lines = logger.warn.mock.calls;
      expect(String(lines[lines.length - 1][0])).not.toContain("suppressed");
    });
  });

  describe("isAvailable", () => {
    it("does not consume the probe slot", () => {
      driveOpen();
      advance(OPEN_WINDOW_MS + 1);
      expect(service.isAvailable(PROVIDER)).toBe(true);
      expect(service.isAvailable(PROVIDER)).toBe(true);
      // The probe is still there for the caller that actually makes a request.
      expect(() => service.assertAvailable(PROVIDER)).not.toThrow();
    });

    it("is false while the window has not elapsed", () => {
      driveOpen();
      expect(service.isAvailable(PROVIDER)).toBe(false);
    });
  });
});
