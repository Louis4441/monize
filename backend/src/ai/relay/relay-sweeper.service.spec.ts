import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";

import { RelaySweeperService } from "./relay-sweeper.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

jest.mock("../../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

describe("RelaySweeperService", () => {
  let service: RelaySweeperService;
  let manager: Record<string, jest.Mock>;

  beforeEach(async () => {
    const scoped = createScopedDbMocks();
    manager = scoped.manager as Record<string, jest.Mock>;
    manager.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RelaySweeperService,
        { provide: DataSource, useValue: scoped.dataSource },
      ],
    }).compile();
    service = module.get(RelaySweeperService);
  });

  afterEach(() => jest.clearAllMocks());

  const statements = () =>
    manager.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "));

  it("expires, deletes and drops cards in one transaction", async () => {
    await service.sweepRelayState();

    const [expire, remove, cards] = statements();
    expect(expire).toContain("UPDATE ai_relay_prompts SET status = 'expired'");
    expect(remove).toContain("DELETE FROM ai_relay_prompts");
    expect(cards).toContain("DELETE FROM ai_relay_actions");
  });

  it("compares every cutoff against the database's clock", async () => {
    await service.sweepRelayState();

    // A cutoff computed in this process would have two replicas disagreeing
    // about which rows are dead, and would make the sweep unrepeatable.
    for (const sql of statements()) {
      expect(sql).toContain("CURRENT_TIMESTAMP");
      expect(sql).not.toMatch(/\$\d::timestamptz/);
    }
  });

  it("gives an abandoned turn the same grace post_response does", async () => {
    await service.sweepRelayState();

    // The sweep must never close a turn whose answer the relay would still
    // have accepted, so both use BUFFER_TTL_MS past the deadline.
    const [expire] = manager.query.mock.calls;
    expect(expire[1]).toEqual([10 * 60 * 1000]);
  });

  it("never touches a turn that is still running", async () => {
    await service.sweepRelayState();

    const [expire] = statements();
    expect(expire).toContain(
      "status = 'pending' AND expires_at <= CURRENT_TIMESTAMP",
    );
    expect(expire).toContain("status IN ('claimed', 'answered')");
  });

  it("logs nothing when there was nothing to sweep", async () => {
    const log = jest.spyOn(service["logger"], "log").mockImplementation();
    manager.query.mockResolvedValue([]);

    await service.sweepRelayState();

    expect(log).not.toHaveBeenCalled();
  });

  it("reports what it swept when there was something", async () => {
    const log = jest.spyOn(service["logger"], "log").mockImplementation();
    // What `pg` returns from a DELETE/UPDATE: the rows, then the count.
    manager.query.mockResolvedValue([[], 3] as never);

    await service.sweepRelayState();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("3 turn(s) expired"),
    );
  });

  it("warns and swallows a failure rather than throwing out of the cron", async () => {
    const warn = jest.spyOn(service["logger"], "warn").mockImplementation();
    manager.query.mockRejectedValue(new Error("connection reset"));

    // Nothing depends on this run having happened, and a throw out of a cron
    // handler is an unhandled rejection rather than a report anyone reads.
    await expect(service.sweepRelayState()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("connection reset"),
    );
  });
});
