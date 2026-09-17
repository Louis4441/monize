import { DataSource } from "typeorm";

import { AuthStateSweeperService } from "./auth-state-sweeper.service";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

/**
 * What matters about a sweep is its predicate, so that is what these pin down.
 *
 * A sweep that took a JavaScript `Date` and passed it as a parameter would look
 * identical from the outside and be wrong in the way this codebase has been
 * wrong before: every replica holds its own clock, and the earliest one would
 * delete a counter another replica is still enforcing. The predicate is the
 * stored expiry against the database's `CURRENT_TIMESTAMP`, and the assertion
 * below is on that, not on a row count.
 */
describe("AuthStateSweeperService", () => {
  let service: AuthStateSweeperService;
  let manager: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;

  beforeEach(() => {
    ({ dataSource, manager } = createScopedDbMocks([]));
    service = new AuthStateSweeperService(dataSource as unknown as DataSource);
  });

  afterEach(() => jest.restoreAllMocks());

  const statements = (): string[] =>
    manager.query.mock.calls.map((call) => String(call[0]));

  /** The instance's own Logger; it is a field, not a prototype member. */
  const spyOnLogger = (method: "log" | "warn"): jest.SpyInstance =>
    jest
      .spyOn(
        (service as unknown as { logger: Record<string, () => void> }).logger,
        method,
      )
      .mockImplementation();

  it("deletes both tables by their stored expiry, with no clock of its own", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await service.sweepExpiredAuthState();

    const [counters, tokens] = statements();
    expect(counters).toMatch(
      /DELETE FROM auth_attempt_counters\s+WHERE window_expires_at < CURRENT_TIMESTAMP/,
    );
    expect(tokens).toMatch(
      /DELETE FROM single_use_tokens\s+WHERE expires_at < CURRENT_TIMESTAMP/,
    );
    // No bound parameters: a time this process computed is the defect above.
    for (const call of manager.query.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  it("sweeps both tables in one transaction", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await service.sweepExpiredAuthState();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(statements()).toHaveLength(2);
  });

  it("logs what it removed only when it removed something", async () => {
    const log = spyOnLogger("log");

    manager.query.mockResolvedValue([[], 0]);
    await service.sweepExpiredAuthState();
    expect(log).not.toHaveBeenCalled();

    // The `[rows, rowCount]` tuple a data-modifying query really returns, which
    // is the shape `affectedRowCount` exists to read: `result.length` on it is
    // always 2, so a naive reading would report two rows swept on every run.
    manager.query.mockResolvedValue([[], 3]);
    await service.sweepExpiredAuthState();
    expect(log).toHaveBeenCalledWith(
      "Swept 3 expired attempt counter(s) and 3 expired single-use token(s)",
    );
  });

  it("warns and swallows a failure instead of rejecting out of the cron", async () => {
    const warn = spyOnLogger("warn");
    manager.query.mockRejectedValue(new Error("connection reset"));

    await expect(service.sweepExpiredAuthState()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Auth state sweep failed: connection reset",
    );
  });
});
