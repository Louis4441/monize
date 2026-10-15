import { ConflictException, NotFoundException } from "@nestjs/common";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceipt } from "../entities/email-receipt.entity";
import {
  EmailReceiptTradeLinkService,
  RECEIPT_TRADE_LINKED_REASON,
} from "./email-receipt-trade-link.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const RECEIPT = "receipt-1";
const IT = "it-1";

const tradeReceipt = (over: Partial<EmailReceipt> = {}) =>
  Object.assign(new EmailReceipt(), {
    id: RECEIPT,
    userId: USER,
    status: "ignored",
    aiReviewRequestId: null,
    trade: { accountId: "acc-1", symbol: "XCNS", action: "BUY" },
    ...over,
  });

const investmentRow = {
  id: IT,
  account_id: "acc-1",
  security_id: "sec-1",
  action: "BUY",
  date: "2026-10-15",
  commission: "0.0000",
};

function setup(
  receipt: EmailReceipt | null = tradeReceipt(),
  rows: unknown[] = [investmentRow],
  requestStatus: string | null = null,
) {
  const receiptRepo = {
    findOne: jest.fn(async () => receipt),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
  ]);
  manager.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("SELECT status FROM ai_review_requests")) {
      return requestStatus === null ? [] : [{ status: requestStatus }];
    }
    if (text.includes("FROM investment_transactions it\n            WHERE")) {
      return rows;
    }
    return [];
  });
  const scheduled = {
    findInvestmentOccurrenceForTrade: jest.fn(async () => null as unknown),
    post: jest.fn(async () => null),
  };
  const service = new EmailReceiptTradeLinkService(
    dataSource as never,
    scheduled as never,
  );
  return { service, manager, receiptRepo, scheduled };
}

describe("EmailReceiptTradeLinkService.link", () => {
  it("closes the email as covered by the transaction, dismissing its open request", async () => {
    const { service, manager, receiptRepo } = setup();
    await service.link(USER, RECEIPT, IT);
    const sqls = manager.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("SET status = 'rejected'"))).toBe(true);
    expect(receiptRepo.update).toHaveBeenCalledWith(
      { id: RECEIPT, userId: USER },
      {
        status: "ignored",
        statusReason: RECEIPT_TRADE_LINKED_REASON,
        aiReviewRequestId: null,
      },
    );
  });

  it("reads the transaction by id and owner and never a VOID one", async () => {
    const { service, manager } = setup();
    await service.link(USER, RECEIPT, IT);
    const call = manager.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM investment_transactions it\n"),
    );
    expect(String(call?.[0])).toContain("it.status != 'VOID'");
    expect(call?.[1]).toEqual([IT, USER]);
  });

  it("marks the scheduled bill it pays as paid, writing no money, and the check uses the linked transaction's own figures", async () => {
    const { service, scheduled } = setup();
    scheduled.findInvestmentOccurrenceForTrade.mockResolvedValue({
      id: "st-1",
      name: "Monthly XCNS",
      dueDate: "2026-10-16",
    });
    await service.link(USER, RECEIPT, IT);
    expect(scheduled.findInvestmentOccurrenceForTrade).toHaveBeenCalledWith(
      USER,
      {
        accountId: "acc-1",
        securityId: "sec-1",
        action: "BUY",
        date: "2026-10-15",
        commission: 0,
      },
    );
    expect(scheduled.post).toHaveBeenCalledWith(USER, "st-1", undefined, {
      expectedDueDate: "2026-10-16",
      recordOnly: true,
    });
  });

  it("posts nothing when no scheduled transaction fits", async () => {
    const { service, scheduled } = setup();
    await service.link(USER, RECEIPT, IT);
    expect(scheduled.post).not.toHaveBeenCalled();
  });

  it("is still linked when the occurrence was paid in the meantime", async () => {
    const { service, scheduled, receiptRepo } = setup();
    scheduled.findInvestmentOccurrenceForTrade.mockResolvedValue({
      id: "st-1",
      name: "x",
      dueDate: "2026-10-16",
    });
    scheduled.post.mockRejectedValue(new ConflictException("posted"));
    await service.link(USER, RECEIPT, IT);
    expect(receiptRepo.update).toHaveBeenCalled();
  });

  it("does not hide a failure of the post that is not a conflict", async () => {
    const { service, scheduled } = setup();
    scheduled.findInvestmentOccurrenceForTrade.mockResolvedValue({
      id: "st-1",
      name: "x",
      dueDate: "2026-10-16",
    });
    scheduled.post.mockRejectedValue(new Error("db down"));
    await expect(service.link(USER, RECEIPT, IT)).rejects.toThrow("db down");
  });

  it("refuses an email that is not a trade, a transaction that is not found, and an applied proposal, writing nothing", async () => {
    let h = setup(tradeReceipt({ trade: null }));
    await expect(service_link(h)).rejects.toMatchObject({ status: 400 });
    expect(h.receiptRepo.update).not.toHaveBeenCalled();

    h = setup(tradeReceipt(), []);
    await expect(service_link(h)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.receiptRepo.update).not.toHaveBeenCalled();

    h = setup(
      tradeReceipt({ aiReviewRequestId: "rq" }),
      [investmentRow],
      "applied",
    );
    await expect(service_link(h)).rejects.toBeInstanceOf(ConflictException);
    expect(h.receiptRepo.update).not.toHaveBeenCalled();

    h = setup(null);
    await expect(service_link(h)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("links nothing of a skipped email", async () => {
    const h = setup(tradeReceipt({ status: "skipped" }));
    await expect(service_link(h)).rejects.toBeInstanceOf(ConflictException);
  });
});

const service_link = (h: ReturnType<typeof setup>) =>
  h.service.link(USER, RECEIPT, IT);

describe("EmailReceiptTradeLinkService.candidates", () => {
  it("offers the user's own non-VOID trades of the account, direction and ticker near the trade's day", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      {
        id: IT,
        date: "2026-10-15",
        total_amount: "2000.0000",
        currency_code: "CAD",
        symbol: "XCNS.TO",
        quantity: "75.9878",
        description: null,
      },
    ]);
    const out = await service.candidates(
      manager as never,
      USER,
      { accountId: "acc-1", symbol: "XCNS", action: "BUY", date: "2026-10-15" },
      "2026-10-16T00:00:00.000Z",
    );
    expect(out).toEqual([
      {
        id: IT,
        date: "2026-10-15",
        amount: 2000,
        currencyCode: "CAD",
        payeeName: "XCNS.TO",
        description: "75.9878",
      },
    ]);
    const [sql, params] = manager.query.mock.calls[0];
    expect(String(sql)).toContain("it.status != 'VOID'");
    expect(params.slice(0, 4)).toEqual([USER, "acc-1", "BUY", "2026-10-15"]);
  });

  it("dates the search by the email when the reading has no date, and offers nothing for a reading without an account", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await service.candidates(
      manager as never,
      USER,
      { accountId: "acc-1", symbol: "XCNS", action: "SELL" },
      "2026-10-16T00:00:00.000Z",
    );
    expect(manager.query.mock.calls[0][1][3]).toBe("2026-10-16");
    manager.query.mockClear();
    expect(
      await service.candidates(
        manager as never,
        USER,
        { symbol: "X" },
        "2026-10-16T00:00:00Z",
      ),
    ).toEqual([]);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
