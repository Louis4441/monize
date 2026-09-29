import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { AiReviewRequest } from "./ai-review-request.entity";
import { AiReviewWorkService } from "./ai-review-work.service";
import { ASSISTANT_CLAIM_KEY } from "./ai-review-work.types";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const REQ = "30000000-0000-4000-8000-000000000001";
const TX = "10000000-0000-4000-8000-000000000001";
const RULE = "20000000-0000-4000-8000-000000000001";

function request(over: Partial<AiReviewRequest> = {}): AiReviewRequest {
  return Object.assign(new AiReviewRequest(), {
    id: REQ,
    userId: USER,
    transactionId: TX,
    ruleId: RULE,
    kind: "transaction_review",
    instruction: "Split by the order items",
    status: "claimed",
    claimedBy: "agent-1",
    claimedAt: new Date("2026-09-29T09:00:00Z"),
    proposal: null,
    createdAt: new Date("2026-09-29T08:00:00Z"),
    updatedAt: new Date("2026-09-29T09:00:00Z"),
    expiresAt: new Date("2026-10-29T08:00:00Z"),
    ...over,
  });
}

const preview = { transactionId: TX, amount: -50 };
const card = (id = "a1") =>
  ({
    actionId: id,
    type: "update_transaction",
    preview: { splits: [] },
    descriptor: { type: "update_transaction", aiReviewRequestId: REQ },
  }) as never;

function setup() {
  const txRepo = { find: jest.fn().mockResolvedValue([]) };
  const ruleRepo = { find: jest.fn().mockResolvedValue([]) };
  const { dataSource } = createScopedDbMocks([
    [Transaction, txRepo],
    [TransactionRule, ruleRepo],
  ]);
  const requests = {
    listForUser: jest.fn().mockResolvedValue([]),
    getForUser: jest.fn().mockResolvedValue(request()),
    claimNext: jest.fn(),
    submitProposal: jest.fn(),
    release: jest.fn(),
    dismiss: jest.fn(),
  };
  const transactions = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: TX, amount: -50, isTransfer: false }),
    getLlmTransactionById: jest
      .fn()
      .mockResolvedValue([{ id: TX, amount: -50 }]),
  };
  const prep = {
    prepareUpdate: jest
      .fn()
      .mockResolvedValue({ kind: "standard", preview, splits: [{ x: 1 }] }),
  };
  const builder = { buildUpdateTransaction: jest.fn().mockReturnValue(card()) };
  const service = new AiReviewWorkService(
    dataSource as unknown as DataSource,
    requests as never,
    transactions as never,
    prep as never,
    builder as never,
  );
  return { service, requests, transactions, prep, builder, txRepo, ruleRepo };
}

const lines = [
  { categoryName: "Books", amount: -30 },
  { categoryName: "Toys", amount: -20 },
];

describe("AiReviewWorkService.list", () => {
  it("asks for open, unexpired requests and says whether the page was cut", async () => {
    const { service, requests } = setup();
    requests.listForUser.mockResolvedValue([
      request({ status: "pending", claimedBy: null }),
      request({ id: "b", status: "claimed" }),
      request({ id: "c", status: "proposed" }),
    ]);

    const list = await service.list(USER, "agent-1", 2);

    expect(requests.listForUser).toHaveBeenCalledWith(USER, {
      statuses: ["pending", "claimed", "proposed"],
      unexpiredOnly: true,
      limit: 3,
    });
    expect(list.requests).toHaveLength(2);
    expect(list.truncated).toBe(true);
    expect(list.requests[1].claimedByYou).toBe(true);
    // The claim key itself never reaches a model.
    expect(JSON.stringify(list)).not.toContain('"claimedBy"');
  });

  it("clamps the limit to the tool ceiling", async () => {
    const { service, requests } = setup();
    await service.list(USER, "agent-1", 9999);
    expect(requests.listForUser).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ limit: 51 }),
    );
  });
});

describe("AiReviewWorkService.claim", () => {
  it("claims for the caller and returns the transaction through the LLM read path", async () => {
    const { service, requests, transactions } = setup();
    requests.claimNext.mockResolvedValue(request());

    const claimed = await service.claim(USER, "agent-1");

    expect(requests.claimNext).toHaveBeenCalledWith(USER, "agent-1");
    expect(transactions.getLlmTransactionById).toHaveBeenCalledWith(USER, TX);
    expect(claimed.request?.id).toBe(REQ);
    expect(claimed.transaction).toEqual([{ id: TX, amount: -50 }]);
  });

  it("returns no request when nothing is pending", async () => {
    const { service, requests, transactions } = setup();
    requests.claimNext.mockResolvedValue(null);
    expect(await service.claim(USER, "agent-1")).toEqual({ request: null });
    expect(transactions.getLlmTransactionById).not.toHaveBeenCalled();
  });

  it("gives the request back rather than stranding it when the transaction cannot be read", async () => {
    const { service, requests, transactions } = setup();
    requests.claimNext.mockResolvedValue(request());
    transactions.getLlmTransactionById.mockRejectedValue(new Error("boom"));

    await expect(service.claim(USER, "agent-1")).rejects.toThrow("boom");

    expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
      final: false,
      note: expect.any(String),
    });
  });

  it("surfaces a previous agent's note", async () => {
    const { service, requests } = setup();
    requests.claimNext.mockResolvedValue(
      request({
        proposal: { agentNote: { reason: "no order id", at: "2026-09-28" } },
      }),
    );
    const claimed = await service.claim(USER, "agent-1");
    expect(claimed.request?.agentNote).toEqual({
      reason: "no order id",
      at: "2026-09-28",
    });
  });
});

describe("AiReviewWorkService.submit", () => {
  it("builds the card through the update_transaction preparation and stores it, writing no transaction", async () => {
    const { service, requests, prep, builder, transactions } = setup();
    requests.submitProposal.mockResolvedValue(request({ status: "proposed" }));

    const result = await service.submit(USER, "agent-1", REQ, {
      splits: lines,
      description: "Allegro order",
    });

    expect(prep.prepareUpdate).toHaveBeenCalledWith(USER, {
      transactionId: TX,
      splits: lines,
      categoryName: undefined,
      payeeName: undefined,
      description: "Allegro order",
    });
    expect(builder.buildUpdateTransaction).toHaveBeenCalledWith(
      USER,
      preview,
      [{ x: 1 }],
      undefined,
      { aiReviewRequestId: REQ },
    );
    expect(requests.submitProposal).toHaveBeenCalledWith(
      USER,
      REQ,
      "agent-1",
      expect.objectContaining({
        input: { splits: lines, description: "Allegro order" },
        action: card(),
      }),
    );
    expect(result.action).toEqual(card());
    expect(result.request.status).toBe("proposed");
    // Reading is all it did to the ledger.
    expect(Object.keys(transactions)).toEqual([
      "findOne",
      "getLlmTransactionById",
    ]);
  });

  it("refuses lines that do not add up, naming the difference, before storing anything", async () => {
    const { service, requests, prep } = setup();

    await expect(
      service.submit(USER, "agent-1", REQ, {
        splits: [
          { categoryName: "Books", amount: -30 },
          { categoryName: "Toys", amount: -17.5 },
        ],
      }),
    ).rejects.toThrow(
      /add up to -47.5 but the transaction is -50: -2.5 is not assigned/,
    );

    expect(prep.prepareUpdate).not.toHaveBeenCalled();
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });

  it.each([
    ["not found", () => null, 404],
    ["pending", () => request({ status: "pending", claimedBy: null }), 409],
    ["claimed by another agent", () => request({ claimedBy: "agent-2" }), 409],
    ["already proposed", () => request({ status: "proposed" }), 409],
    ["dismissed", () => request({ status: "rejected", claimedBy: null }), 409],
  ])(
    "refuses a request that is %s, before building or storing",
    async (_n, make, status) => {
      const { service, requests, prep } = setup();
      requests.getForUser.mockResolvedValue(make());

      await expect(
        service.submit(USER, "agent-1", REQ, { description: "x" }),
      ).rejects.toMatchObject({ status });

      expect(prep.prepareUpdate).not.toHaveBeenCalled();
      expect(requests.submitProposal).not.toHaveBeenCalled();
    },
  );

  it("refuses when the claim is lost between the check and the conditional update", async () => {
    const { service, requests } = setup();
    requests.submitProposal.mockResolvedValue(null);
    await expect(
      service.submit(USER, "agent-1", REQ, { description: "x" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a proposal with no change, and splits together with a category", async () => {
    const { service, requests } = setup();
    await expect(
      service.submit(USER, "agent-1", REQ, {}),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.submit(USER, "agent-1", REQ, {
        splits: lines,
        categoryName: "Books",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });

  it("refuses a transfer", async () => {
    const { service, requests, transactions } = setup();
    transactions.findOne.mockResolvedValue({
      id: TX,
      amount: -50,
      isTransfer: true,
    });
    await expect(
      service.submit(USER, "agent-1", REQ, { description: "x" }),
    ).rejects.toThrow(/transfer cannot be reviewed/);
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });

  it("passes a preparation refusal (unknown category) through unchanged", async () => {
    const { service, requests, prep } = setup();
    prep.prepareUpdate.mockRejectedValue(new Error("Unknown category: Nope"));
    await expect(
      service.submit(USER, "agent-1", REQ, { categoryName: "Nope" }),
    ).rejects.toThrow("Unknown category: Nope");
    expect(requests.submitProposal).not.toHaveBeenCalled();
  });
});

describe("AiReviewWorkService.reject", () => {
  it("returns a request to the queue by default", async () => {
    const { service, requests } = setup();
    requests.release.mockResolvedValue(
      request({ status: "pending", claimedBy: null }),
    );

    const released = await service.reject(
      USER,
      "agent-1",
      REQ,
      "no order id",
      false,
    );

    expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
      final: false,
      note: "no order id",
    });
    expect(released.status).toBe("pending");
  });

  it("closes a request that cannot be done", async () => {
    const { service, requests } = setup();
    requests.release.mockResolvedValue(
      request({ status: "rejected", claimedBy: null }),
    );
    await service.reject(USER, "agent-1", REQ, "not an order", true);
    expect(requests.release).toHaveBeenCalledWith(USER, REQ, "agent-1", {
      final: true,
      note: "not an order",
    });
  });

  it("refuses an agent that does not hold the claim, releasing nothing", async () => {
    const { service, requests } = setup();
    await expect(
      service.reject(USER, "agent-2", REQ, "x", false),
    ).rejects.toMatchObject({ status: 409 });
    expect(requests.release).not.toHaveBeenCalled();
  });

  it("keys the assistant on its own claim key", () => {
    expect(ASSISTANT_CLAIM_KEY).toBe("assistant");
  });
});

describe("AiReviewWorkService inbox", () => {
  const tx = {
    id: TX,
    transactionDate: "2026-09-01",
    amount: "-50.0000",
    currencyCode: "PLN",
    payeeName: "ALLEGRO",
    description: null,
    accountId: "acc-1",
    account: { name: "Checking" },
    category: null,
    isSplit: false,
  };

  it("lists newest first with a transaction summary and the rule's name", async () => {
    const { service, requests, txRepo, ruleRepo } = setup();
    requests.listForUser.mockResolvedValue([
      request({ status: "pending", claimedBy: null }),
    ]);
    txRepo.find.mockResolvedValue([tx]);
    ruleRepo.find.mockResolvedValue([{ id: RULE, name: "Allegro" }]);

    const items = await service.listInbox(USER);

    expect(requests.listForUser).toHaveBeenCalledWith(USER, {
      statuses: ["pending", "claimed", "proposed", "expired"],
      limit: 50,
      order: "DESC",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: REQ,
      ruleName: "Allegro",
      transaction: {
        id: TX,
        date: "2026-09-01",
        amount: -50,
        accountName: "Checking",
        payeeName: "ALLEGRO",
      },
    });
    expect(items[0].proposal).toBeUndefined();
    expect(items[0]).not.toHaveProperty("claimedBy");
  });

  it("rebuilds the card of a proposed request against the transaction as it is now", async () => {
    const { service, requests, txRepo, prep } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "proposed",
        proposal: { input: { description: "x" }, action: card("old") },
      }),
    ]);
    txRepo.find.mockResolvedValue([tx]);

    const items = await service.listInbox(USER);

    expect(prep.prepareUpdate).toHaveBeenCalled();
    expect(items[0].proposal).toEqual({ action: card() });
  });

  it("shows why a proposal can no longer be built instead of failing the list", async () => {
    const { service, requests, txRepo, transactions } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "proposed",
        proposal: { input: { splits: lines } },
      }),
    ]);
    txRepo.find.mockResolvedValue([tx]);
    transactions.findOne.mockResolvedValue({
      id: TX,
      amount: -80,
      isTransfer: false,
    });

    const items = await service.listInbox(USER);

    expect(items[0].proposal).toEqual({
      error: expect.stringMatching(/not assigned/),
    });
  });

  it("does not turn an internal error into a proposal's reason", async () => {
    const { service, requests, txRepo, prep } = setup();
    requests.listForUser.mockResolvedValue([
      request({
        status: "proposed",
        proposal: { input: { description: "x" } },
      }),
    ]);
    txRepo.find.mockResolvedValue([tx]);
    prep.prepareUpdate.mockRejectedValue(new Error("connection reset"));
    await expect(service.listInbox(USER)).rejects.toThrow("connection reset");
  });

  it("marks a transaction that no longer exists as null", async () => {
    const { service, requests } = setup();
    requests.listForUser.mockResolvedValue([request({ status: "pending" })]);
    const items = await service.listInbox(USER);
    expect(items[0].transaction).toBeNull();
    expect(items[0].ruleName).toBeNull();
  });

  it("returns an empty list without touching the transactions", async () => {
    const { service, txRepo } = setup();
    expect(
      await service.listInbox(USER, { status: "applied", limit: 5 }),
    ).toEqual([]);
    expect(txRepo.find).not.toHaveBeenCalled();
  });

  it("dismisses an open request and answers with its inbox entry", async () => {
    const { service, requests, txRepo } = setup();
    requests.dismiss.mockResolvedValue(
      request({ status: "rejected", claimedBy: null }),
    );
    txRepo.find.mockResolvedValue([tx]);
    const item = await service.dismiss(USER, REQ);
    expect(requests.dismiss).toHaveBeenCalledWith(USER, REQ);
    expect(item.status).toBe("rejected");
  });

  it("answers 404 for a request that is not the user's and 409 for one no longer open", async () => {
    const { service, requests } = setup();
    requests.dismiss.mockResolvedValue(null);
    requests.getForUser.mockResolvedValue(null);
    await expect(service.dismiss(USER, REQ)).rejects.toMatchObject({
      status: 404,
    });
    requests.getForUser.mockResolvedValue(request({ status: "applied" }));
    await expect(service.dismiss(USER, REQ)).rejects.toMatchObject({
      status: 409,
    });
  });
});
