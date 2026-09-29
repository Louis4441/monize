import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { AiReviewRequest } from "./ai-review-request.entity";
import { AiReviewRequestsService } from "./ai-review-requests.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const TX_1 = "10000000-0000-4000-8000-000000000001";
const TX_2 = "10000000-0000-4000-8000-000000000002";
const RULE_1 = "20000000-0000-4000-8000-000000000001";
const RULE_2 = "20000000-0000-4000-8000-000000000002";

function setup() {
  const repo = { find: jest.fn().mockResolvedValue([]) };
  const { manager, dataSource } = createScopedDbMocks([
    [AiReviewRequest, repo],
  ]);
  const service = new AiReviewRequestsService(
    dataSource as unknown as DataSource,
  );
  return { service, manager, repo };
}

describe("AiReviewRequestsService.enqueue", () => {
  it("writes the whole batch in one parameterized INSERT ... ON CONFLICT DO NOTHING on the caller's manager", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { transaction_id: TX_1, rule_id: RULE_1 },
      { transaction_id: TX_2, rule_id: RULE_2 },
    ]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: RULE_1, instruction: " one " },
      { transactionId: TX_2, ruleId: RULE_2, instruction: "two" },
    ]);

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_review_requests/);
    expect(sql).toMatch(
      /ON CONFLICT \(transaction_id, rule_id\)\s+WHERE status IN \('pending', 'claimed', 'proposed'\)\s+DO NOTHING/,
    );
    expect(sql).toMatch(/RETURNING transaction_id, rule_id/);
    expect(sql).not.toContain(TX_1);
    expect(params).toEqual([
      USER,
      [TX_1, TX_2],
      [RULE_1, RULE_2],
      ["one", "two"],
    ]);
    expect(result.queued).toEqual([
      { transactionId: TX_1, ruleId: RULE_1 },
      { transactionId: TX_2, ruleId: RULE_2 },
    ]);
    expect(result.alreadyQueued).toEqual([]);
  });

  it("reports a request the unique index skipped as already queued", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { transaction_id: TX_2, rule_id: RULE_2 },
    ]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: RULE_1, instruction: "one" },
      { transactionId: TX_2, ruleId: RULE_2, instruction: "two" },
    ]);

    expect(result.queued).toEqual([{ transactionId: TX_2, ruleId: RULE_2 }]);
    expect(result.alreadyQueued).toEqual([
      { transactionId: TX_1, ruleId: RULE_1 },
    ]);
  });

  it("counts the second copy of a request inside one batch as already queued", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { transaction_id: TX_1, rule_id: RULE_1 },
    ]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: RULE_1, instruction: "same" },
      { transactionId: TX_1, ruleId: RULE_1, instruction: "same" },
    ]);

    expect(result.queued).toHaveLength(1);
    expect(result.alreadyQueued).toHaveLength(1);
  });

  it("sends a request with no rule as a null in the rule array", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ transaction_id: TX_1, rule_id: null }]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: null, instruction: "manual" },
    ]);

    expect(manager.query.mock.calls[0][1][2]).toEqual([null]);
    expect(result.queued).toEqual([{ transactionId: TX_1, ruleId: null }]);
  });

  it("chunks a large batch so no statement carries an unbounded array", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    const requests = Array.from({ length: 1001 }, () => ({
      transactionId: TX_1,
      ruleId: RULE_1,
      instruction: "x",
    }));

    await service.enqueue(manager as never, USER, requests);

    expect(manager.query.mock.calls.map((c) => c[1][1].length)).toEqual([
      500, 500, 1,
    ]);
  });

  it("issues no statement for an empty batch", async () => {
    const { service, manager } = setup();
    const result = await service.enqueue(manager as never, USER, []);
    expect(manager.query).not.toHaveBeenCalled();
    expect(result).toEqual({ queued: [], alreadyQueued: [] });
  });
});

describe("AiReviewRequestsService.claimNext", () => {
  const row = {
    id: "30000000-0000-4000-8000-000000000001",
    user_id: USER,
    transaction_id: TX_1,
    rule_id: RULE_1,
    kind: "transaction_review",
    instruction: "look",
    status: "claimed",
    claimed_by: "agent-1",
    claimed_at: new Date("2026-09-29T10:00:00Z"),
    proposal: null,
    created_at: new Date("2026-09-29T09:00:00Z"),
    updated_at: new Date("2026-09-29T10:00:00Z"),
    expires_at: new Date("2026-10-29T09:00:00Z"),
  };

  it("claims with ONE conditional UPDATE over a FOR UPDATE SKIP LOCKED subselect", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[row], 1]);

    const claimed = await service.claimNext(USER, "agent-1");

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/^UPDATE ai_review_requests/);
    expect(sql).toMatch(/SET status = 'claimed'/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(
      /status = 'pending'\s+AND expires_at > CURRENT_TIMESTAMP/,
    );
    expect(sql).toMatch(/ORDER BY created_at, id/);
    expect(sql).toMatch(
      /AND status = 'pending'\s+AND user_id = \$1\s+RETURNING/,
    );
    expect(params).toEqual([USER, "agent-1"]);
    expect(claimed).toMatchObject({
      id: row.id,
      userId: USER,
      transactionId: TX_1,
      ruleId: RULE_1,
      status: "claimed",
      claimedBy: "agent-1",
    });
    expect(claimed).toBeInstanceOf(AiReviewRequest);
  });

  it("returns null when nothing is pending", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[], 0]);
    expect(await service.claimNext(USER, "agent-1")).toBeNull();
  });
});

describe("AiReviewRequestsService.listForUser", () => {
  it("filters by user and status, oldest first, with the limit clamped", async () => {
    const { service, repo } = setup();
    await service.listForUser(USER, { status: "pending", limit: 5000 });
    expect(repo.find).toHaveBeenCalledWith({
      where: { userId: USER, status: "pending" },
      order: { createdAt: "ASC", id: "ASC" },
      take: 200,
    });
  });

  it("defaults to every status and 50 rows", async () => {
    const { service, repo } = setup();
    await service.listForUser(USER);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER }, take: 50 }),
    );
  });
});

describe("AiReviewRequestsService.expireStale", () => {
  it("expires only open requests past their life and returns how many", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[{ id: "a" }, { id: "b" }], 2]);

    expect(await service.expireStale()).toBe(2);

    const [sql] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'expired'/);
    expect(sql).toMatch(/status IN \('pending', 'claimed', 'proposed'\)/);
    expect(sql).toMatch(/expires_at <= CURRENT_TIMESTAMP/);
  });
});
