import { Global, Module } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiModule } from "@/ai/ai.module";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewQueueModule } from "@/ai-review/ai-review-queue.module";
import { EVENT_BUS } from "@/common/events/event-bus.interface";
import { MemoryEventBus } from "@/common/events/memory-event-bus";
import { JobClaimModule } from "@/common/jobs/job-claim.module";
import { withUserContext } from "@/common/db/with-context";
import { EncryptionService } from "@/common/encryption/encryption.service";
import { EmailReceiptsModule } from "@/email-receipts/email-receipts.module";
import {
  ImapMailboxClient,
  type FetchSinceResult,
} from "@/email-receipts/imap/imap-mailbox-client";
import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_CONTRACT_1,
  ALLEGRO_PAY_CONTRACT_2,
  ALLEGRO_PAY_PURCHASE_LINES,
  ALLEGRO_PAY_PURCHASE_SUBJECT,
  ALLEGRO_PAY_REPAYMENT_LINES,
  ALLEGRO_PAY_REPAYMENT_SUBJECT,
  ALLEGRO_PAY_SETTLEMENT_DEFINITION,
} from "@/email-receipts/parsing/fixtures/allegro-pay-mails";
import { EmailReceiptParsersService } from "@/email-receipts/parsers/email-receipt-parsers.service";
import { EmailReceiptPollService } from "@/email-receipts/poll/email-receipt-poll.service";
import { EmailReceiptsService } from "@/email-receipts/receipts/email-receipts.service";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/** The in-process event bus a `single` deployment binds, without the app's module. */
@Global()
@Module({
  providers: [{ provide: EVENT_BUS, useClass: MemoryEventBus }, MemoryEventBus],
  exports: [EVENT_BUS],
})
class TestEventBusModule {}

/**
 * Linked email receipts end to end (docs/specs/email-receipt-linked-receipts.md)
 * against a real PostgreSQL enforcing RLS: a purchase email is stored as a
 * component; the repayment email that names the bank transaction joins it, and
 * its proposal splits the transaction into the purchase's lines. The two
 * profiles and both emails are the synthetic Allegro Pay fixtures.
 */
describe("linked email receipts (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let poller: EmailReceiptPollService;
  let receipts: EmailReceiptsService;
  let parsers: EmailReceiptParsersService;
  let transactions: TransactionsService;
  let imap: ImapMailboxClient;
  let encryption: EncryptionService;

  let aliceId: string;
  let accountId: string;
  let goodsId: string;
  let shippingId: string;
  let mailboxId: string;
  let txId: string;
  let nextUid = 40;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const serverReturns = (
    from: string,
    subject: string,
    date: string,
    lines: string[],
  ): FetchSinceResult => {
    const uid = String(++nextUid);
    return {
      uidValidity: "1001",
      messages: [
        {
          uid,
          source: Buffer.from(
            [
              `From: Sender <noreply@${from}>`,
              "To: receipts@example.com",
              `Subject: ${subject}`,
              `Date: ${date}`,
              `Message-ID: <m${uid}@${from}>`,
              "Content-Type: text/plain; charset=utf-8",
              "",
              lines.join("\r\n"),
              "",
            ].join("\r\n"),
          ),
          internalDate: new Date(date),
          size: 800,
        },
      ],
      skipped: [],
      highestUid: uid,
    };
  };

  const poll = async (mail: FetchSinceResult) => {
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(mail);
    await asAlice(() =>
      poller.pollMailbox(aliceId, mailboxId, { requireEnabled: true }),
    );
  };

  const purchaseMail = () =>
    serverReturns(
      "shop.example.com",
      ALLEGRO_PAY_PURCHASE_SUBJECT,
      "Mon, 15 Dec 2025 10:00:00 +0000",
      ALLEGRO_PAY_PURCHASE_LINES,
    );
  const repaymentMail = () =>
    serverReturns(
      "pay.example.com",
      ALLEGRO_PAY_REPAYMENT_SUBJECT,
      "Sat, 10 Jan 2026 10:00:00 +0000",
      ALLEGRO_PAY_REPAYMENT_LINES,
    );

  const receiptBy = async (domain: string) =>
    (
      await db.query(`SELECT * FROM email_receipts WHERE from_domain = $1`, [
        domain,
      ])
    )[0];
  const linkRows = () =>
    db.query(
      `SELECT part_index, link_value, part_amount, component_receipt_id, outcome
         FROM email_receipt_links ORDER BY part_index`,
    );

  const createProfiles = async () => {
    const component = await asAlice(() =>
      parsers.create(aliceId, {
        name: "Shop purchases",
        fromDomains: ["shop.example.com"],
        definition: {
          ...ALLEGRO_PAY_COMPONENT_DEFINITION,
          defaultCategoryId: goodsId,
          shippingCategoryId: shippingId,
          tag: "Allegro",
        },
      } as never),
    );
    await asAlice(() =>
      parsers.create(aliceId, {
        name: "Repayments",
        fromDomains: ["pay.example.com"],
        definition: {
          ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
          defaultCategoryId: goodsId,
        },
      } as never),
    );
    return component;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "integration-test-secret";
    process.env.ENCRYPTION_KEY ??= "x".repeat(40);
    harness = await createEnforcedIntegrationModule([
      JobClaimModule,
      TransactionsModule,
      TransactionRulesModule,
      AiReviewModule,
      AiReviewQueueModule,
      AiModule,
      EmailReceiptsModule,
      TestEventBusModule,
    ]);
    module = harness.module;
    db = harness.owner;
    poller = module.get(EmailReceiptPollService);
    receipts = module.get(EmailReceiptsService);
    parsers = module.get(EmailReceiptParsersService);
    transactions = module.get(TransactionsService);
    imap = module.get(ImapMailboxClient);
    encryption = module.get(EncryptionService);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "single_use_tokens",
      "job_claims",
      "ai_review_requests",
      "email_receipt_links",
      "email_receipts",
      "email_receipt_parsers",
      "email_receipt_mailboxes",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "payees",
      "categories",
      "accounts",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    goodsId = (await createTestCategory(db, aliceId, { name: "Goods" })).id;
    shippingId = (await createTestCategory(db, aliceId, { name: "Shipping" }))
      .id;
    txId = (
      await asAlice(() =>
        transactions.create(aliceId, {
          accountId,
          transactionDate: "2026-01-10",
          amount: -272.89,
          currencyCode: "USD",
          description: "ALLEGRO PAY SPLATA",
        } as never),
      )
    ).id;
    const [mailbox] = await db.query(
      `INSERT INTO email_receipt_mailboxes
         (user_id, host, port, security, username, password_enc, enabled, ai_mode, auto_apply)
       VALUES ($1, '8.8.8.8', 993, 'tls', 'receipts@example.com', $2, true, 'off', false)
       RETURNING id`,
      [aliceId, encryption.encrypt("app-password-for-tests")],
    );
    mailboxId = mailbox.id;
  });

  const requests = () =>
    db.query(`SELECT * FROM ai_review_requests ORDER BY created_at`);

  it("stores a purchase as a component, then proposes the repayment's transaction split into the purchase's lines", async () => {
    await createProfiles();

    await poll(purchaseMail());
    const component = await receiptBy("shop.example.com");
    expect(component).toMatchObject({
      status: "component",
      status_reason: "awaiting_settlement",
      link_key: ALLEGRO_PAY_CONTRACT_2,
      transaction_id: null,
      ai_review_request_id: null,
    });
    expect(await requests()).toHaveLength(0);

    await poll(repaymentMail());
    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review",
      status_reason: "partially_linked",
      transaction_id: txId,
      link_key: null,
    });
    const [request] = await requests();
    expect(request).toMatchObject({
      kind: "email_receipt",
      status: "proposed",
      transaction_id: txId,
      email_receipt_id: settlement.id,
    });
    const splits = request.proposal.input.splits as { amount: number }[];
    expect(splits.map((s) => s.amount)).toEqual([-109.89, -140, -10, -13]);
    expect(Math.round(splits.reduce((sum, s) => sum + s.amount * 100, 0))).toBe(
      -27289,
    );
    expect(request.proposal.input.tagNames).toEqual(["Allegro"]);

    const links = await linkRows();
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      part_index: 0,
      link_value: ALLEGRO_PAY_CONTRACT_1,
      outcome: "not_found",
      component_receipt_id: null,
    });
    expect(Number(links[0].part_amount)).toBe(109.89);
    expect(links[1]).toMatchObject({
      part_index: 1,
      link_value: ALLEGRO_PAY_CONTRACT_2,
      outcome: "joined",
      component_receipt_id: component.id,
    });
    expect(Number(links[1].part_amount)).toBe(163);

    // the component keeps its status and now says it is used up
    expect(await receiptBy("shop.example.com")).toMatchObject({
      status: "component",
      status_reason: "settled",
    });

    // ignoring the settlement leaves it no link rows, so it takes nothing
    await asAlice(() => receipts.ignore(aliceId, settlement.id));
    expect(await linkRows()).toHaveLength(0);
  });

  it("reads a repayment with no component stored as the single email would: one line per part", async () => {
    await createProfiles();

    await poll(repaymentMail());

    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review",
      status_reason: "partially_linked",
      transaction_id: txId,
    });
    const [request] = await requests();
    expect(
      (request.proposal.input.splits as { amount: number }[]).map(
        (s) => s.amount,
      ),
    ).toEqual([-109.89, -163]);
    expect((await linkRows()).map((l) => l.outcome)).toEqual([
      "not_found",
      "not_found",
    ]);
  });

  it("is a review_conflict, enriched_by_other, when an unrelated email already enriched the transaction", async () => {
    await createProfiles();
    await poll(
      serverReturns(
        "other.example.org",
        "Unrelated",
        "Fri, 09 Jan 2026 10:00:00 +0000",
        ["Hello"],
      ),
    );
    const unrelated = await receiptBy("other.example.org");
    await db.query(
      `INSERT INTO ai_review_requests
         (user_id, transaction_id, kind, instruction, status, email_receipt_id)
       VALUES ($1, $2, 'email_receipt', 'x', 'applied', $3)`,
      [aliceId, txId, unrelated.id],
    );

    await poll(repaymentMail());

    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review_conflict",
      status_reason: "enriched_by_other",
      transaction_id: null,
      candidate_transaction_ids: [txId],
      ai_review_request_id: null,
    });
    expect(await requests()).toHaveLength(1);
    expect(await linkRows()).toHaveLength(2);
  });

  it("proposes over a transaction that the component it joins had enriched", async () => {
    await createProfiles();
    await poll(purchaseMail());
    const component = await receiptBy("shop.example.com");
    await db.query(
      `INSERT INTO ai_review_requests
         (user_id, transaction_id, kind, instruction, status, email_receipt_id)
       VALUES ($1, $2, 'email_receipt', 'x', 'applied', $3)`,
      [aliceId, txId, component.id],
    );

    await poll(repaymentMail());

    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review",
      transaction_id: txId,
    });
    const proposed = (await requests()).filter((r) => r.status === "proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0].email_receipt_id).toBe(settlement.id);
  });
});
