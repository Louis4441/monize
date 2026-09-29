import { TestingModule } from "@nestjs/testing";
import { DataSource, EntityManager } from "typeorm";

import { AccountsService } from "@/accounts/accounts.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { TransactionRulesApplierService } from "@/transaction-rules/transaction-rules-applier.service";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewRequestsService } from "@/ai-review/ai-review-requests.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The AI review queue against a real PostgreSQL enforcing RLS (task R1, design
 * 6.5). What a mocked manager cannot show: the request shares the create's
 * transaction (a rollback drops it), the partial unique index dedupes a repeat
 * trigger, two concurrent claims never return one row, and one user's queue is
 * invisible to another.
 */
describe("AI review requests (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let applier: TransactionRulesApplierService;
  let runService: TransactionRulesRunService;
  let queue: AiReviewRequestsService;
  let accounts: AccountsService;

  let aliceId: string;
  let bobId: string;
  let accountId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const reviewRule = (
    over: Partial<CreateTransactionRuleDto> = {},
  ): CreateTransactionRuleDto =>
    ({
      name: "Allegro",
      triggers: ["create", "import"],
      condition: { field: "payeeText", op: "contains", value: "allegro" },
      actions: [
        { type: "request_ai_review", instruction: "Split by the order items" },
      ],
      ...over,
    }) as CreateTransactionRuleDto;

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      accountId,
      transactionDate: "2026-03-10",
      amount: -50,
      currencyCode: "USD",
      payeeName: "ALLEGRO 123",
      ...over,
    }) as never;

  const requests = async (): Promise<
    Array<{
      user_id: string;
      transaction_id: string;
      rule_id: string | null;
      status: string;
      instruction: string;
      kind: string;
    }>
  > =>
    db.query(
      `SELECT user_id, transaction_id, rule_id, status, instruction, kind
         FROM ai_review_requests ORDER BY created_at, id`,
    );

  /** Insert n pending requests for a user directly (the owner connection bypasses RLS). */
  async function seedPending(userId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const [tx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-03-10', -1, 'USD', 'UNRECONCILED') RETURNING id`,
        [userId, accountId],
      );
      const [row] = await db.query(
        `INSERT INTO ai_review_requests (user_id, transaction_id, instruction, created_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 || ' seconds')::interval) RETURNING id`,
        [userId, tx.id, `look ${i}`, String(i)],
      );
      ids.push(row.id);
    }
    return ids;
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
      AiReviewModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    applier = module.get(TransactionRulesApplierService);
    runService = module.get(TransactionRulesRunService);
    queue = module.get(AiReviewRequestsService);
    accounts = module.get(AccountsService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "ai_review_requests",
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
  });

  it("a request_ai_review rule queues one pending request in the create's transaction", async () => {
    const rule = await asAlice(() => rules.create(aliceId, reviewRule()));

    const created = await asAlice(() => transactions.create(aliceId, dto()));

    expect(await requests()).toEqual([
      {
        user_id: aliceId,
        transaction_id: created.id,
        rule_id: rule.id,
        status: "pending",
        instruction: "Split by the order items",
        kind: "transaction_review",
      },
    ]);
    // A review request is not a ledger change (INV-RULE-001).
    expect(Number(created.amount)).toBe(-50);
    const [{ current_balance }] = await db.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(Number(current_balance)).toBe(950);
  });

  it("does not queue for a row the rule does not match", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    await asAlice(() =>
      transactions.create(aliceId, dto({ payeeName: "Somewhere else" })),
    );
    expect(await requests()).toEqual([]);
  });

  it("a second identical trigger on the same row does not duplicate the request", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    expect(await requests()).toHaveLength(1);

    const again = await asAlice(() =>
      withScopedDb(harness.app, (m: EntityManager) =>
        applier.applyToNew(m, aliceId, [created.id], "import"),
      ),
    );

    expect(await requests()).toHaveLength(1);
    expect(again[0].effects.trace[0].applied).toEqual([
      { type: "request_ai_review", outcome: "already_queued" },
    ]);
  });

  it("a manual run queues on commit only, and a re-run does not duplicate", async () => {
    const rule = await asAlice(() =>
      rules.create(aliceId, reviewRule({ triggers: ["import"] })),
    );
    const [tx] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, payee_name, status)
       VALUES ($1, $2, '2026-03-11', -20, 'USD', 'ALLEGRO 9', 'UNRECONCILED') RETURNING id`,
      [aliceId, accountId],
    );
    const filters = { limit: 100 };

    const preview = await asAlice(() =>
      runService.previewRun(aliceId, rule.id, filters),
    );
    expect(preview.aiReviewRequests).toBe(1);
    expect(await requests()).toEqual([]);

    await asAlice(() =>
      runService.run(aliceId, rule.id, {
        ...filters,
        fingerprint: preview.fingerprint,
      }),
    );
    expect(await requests()).toHaveLength(1);
    expect((await requests())[0].transaction_id).toBe(tx.id);

    const second = await asAlice(() =>
      runService.previewRun(aliceId, rule.id, filters),
    );
    await asAlice(() =>
      runService.run(aliceId, rule.id, {
        ...filters,
        fingerprint: second.fingerprint,
      }),
    );
    expect(await requests()).toHaveLength(1);
  });

  it("queues a new request once the earlier one is closed", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    await db.query(`UPDATE ai_review_requests SET status = 'rejected'`);

    await asAlice(() =>
      withScopedDb(harness.app, (m: EntityManager) =>
        applier.applyToNew(m, aliceId, [created.id], "import"),
      ),
    );

    expect((await requests()).map((r) => r.status)).toEqual([
      "rejected",
      "pending",
    ]);
  });

  it("a rollback of the create drops the request with the row", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    jest
      .spyOn(accounts, "updateBalance")
      .mockRejectedValue(new Error("balance update failed"));

    await expect(
      asAlice(() => transactions.create(aliceId, dto())),
    ).rejects.toThrow("balance update failed");

    expect(await db.query(`SELECT 1 FROM transactions`)).toHaveLength(0);
    expect(await requests()).toEqual([]);
  });

  it("deleting the asking rule keeps the request, with no rule", async () => {
    const rule = await asAlice(() => rules.create(aliceId, reviewRule()));
    await asAlice(() => transactions.create(aliceId, dto()));

    await db.query(`DELETE FROM transaction_rules WHERE id = $1`, [rule.id]);

    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0].rule_id).toBeNull();
  });

  it("deleting the transaction deletes its request", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    await db.query(`DELETE FROM transactions WHERE id = $1`, [created.id]);
    expect(await requests()).toEqual([]);
  });

  describe("claimNext", () => {
    it("claims the oldest pending request, once", async () => {
      const [first, second] = await seedPending(aliceId, 2);

      const claimed = await asAlice(() => queue.claimNext(aliceId, "agent-1"));
      expect(claimed).toMatchObject({
        id: first,
        status: "claimed",
        claimedBy: "agent-1",
      });
      expect(claimed?.claimedAt).toBeInstanceOf(Date);

      const next = await asAlice(() => queue.claimNext(aliceId, "agent-2"));
      expect(next?.id).toBe(second);
      expect(
        await asAlice(() => queue.claimNext(aliceId, "agent-3")),
      ).toBeNull();
    });

    it("does not claim an expired request", async () => {
      await seedPending(aliceId, 1);
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
      );
      expect(
        await asAlice(() => queue.claimNext(aliceId, "agent-1")),
      ).toBeNull();
    });

    it("skips a row another open claim holds: two concurrent claims never return one row", async () => {
      const [only] = await seedPending(aliceId, 1);

      let releaseFirst!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHasClaimed!: () => void;
      const firstClaimed = new Promise<void>((resolve) => {
        firstHasClaimed = resolve;
      });

      // Transaction A claims and stays open, holding the row lock.
      const a = asAlice(() =>
        withScopedDb(harness.app, async () => {
          const claimed = await queue.claimNext(aliceId, "agent-a");
          firstHasClaimed();
          await hold;
          return claimed;
        }),
      );
      await firstClaimed;

      // Transaction B runs while A is uncommitted: it must not see the row.
      const b = await asAlice(() => queue.claimNext(aliceId, "agent-b"));
      expect(b).toBeNull();

      releaseFirst();
      expect((await a)?.id).toBe(only);
      const rows = await db.query(
        `SELECT claimed_by FROM ai_review_requests WHERE id = $1`,
        [only],
      );
      expect(rows[0].claimed_by).toBe("agent-a");
    });

    it("hands concurrent claimers distinct rows", async () => {
      const ids = await seedPending(aliceId, 3);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          asAlice(() => queue.claimNext(aliceId, `agent-${i}`)),
        ),
      );

      const claimedIds = results.flatMap((r) => (r ? [r.id] : []));
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds.every((id) => ids.includes(id))).toBe(true);
      const rows = await db.query(
        `SELECT status, claimed_by FROM ai_review_requests WHERE status = 'claimed'`,
      );
      expect(rows).toHaveLength(claimedIds.length);
      expect(
        new Set(rows.map((r: { claimed_by: string }) => r.claimed_by)).size,
      ).toBe(rows.length);
    });
  });

  describe("listForUser and expireStale", () => {
    it("lists a user's requests oldest first, filtered by status", async () => {
      const [first, second] = await seedPending(aliceId, 2);
      await db.query(
        `UPDATE ai_review_requests SET status = 'applied' WHERE id = $1`,
        [first],
      );
      const all = await asAlice(() => queue.listForUser(aliceId));
      expect(all.map((r) => r.id)).toEqual([first, second]);
      const pending = await asAlice(() =>
        queue.listForUser(aliceId, { status: "pending" }),
      );
      expect(pending.map((r) => r.id)).toEqual([second]);
    });

    it("expireStale marks open requests past their life as expired and leaves the rest", async () => {
      const [old, fresh] = await seedPending(aliceId, 2);
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = $1`,
        [old],
      );
      expect(await asAlice(() => queue.expireStale())).toBe(1);
      const rows = await db.query(
        `SELECT id, status FROM ai_review_requests ORDER BY created_at`,
      );
      expect(rows).toEqual([
        { id: old, status: "expired" },
        { id: fresh, status: "pending" },
      ]);
    });
  });

  describe("row-level security", () => {
    it("another user cannot list, claim or expire a user's requests", async () => {
      await seedPending(aliceId, 2);

      const listed = await withUserContext(bobId, () =>
        queue.listForUser(aliceId),
      );
      expect(listed).toEqual([]);
      expect(
        await withUserContext(bobId, () => queue.claimNext(aliceId, "bob")),
      ).toBeNull();
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day'`,
      );
      expect(await withUserContext(bobId, () => queue.expireStale())).toBe(0);
      expect((await requests()).map((r) => r.status)).toEqual([
        "pending",
        "pending",
      ]);
    });

    it("refuses to enqueue a row for another user (WITH CHECK)", async () => {
      const [tx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-03-10', -1, 'USD', 'UNRECONCILED') RETURNING id`,
        [aliceId, accountId],
      );
      await expect(
        withUserContext(bobId, () =>
          withScopedDb(harness.app, (m: EntityManager) =>
            queue.enqueue(m, aliceId, [
              { transactionId: tx.id, ruleId: null, instruction: "sneaky" },
            ]),
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(await requests()).toEqual([]);
    });

    it("each user's rules queue only their own requests", async () => {
      await createTestAccount(db, bobId, {
        name: "Bob's",
        currencyCode: "USD",
        openingBalance: 0,
        currentBalance: 0,
      });
      await asAlice(() => rules.create(aliceId, reviewRule()));
      await asAlice(() => transactions.create(aliceId, dto()));
      expect((await requests()).map((r) => r.user_id)).toEqual([aliceId]);
      expect(
        await withUserContext(bobId, () => queue.listForUser(bobId)),
      ).toEqual([]);
    });
  });
});
