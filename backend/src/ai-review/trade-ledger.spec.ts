import {
  emailDayOfUser,
  findTradeInLedger,
  recordTradeBooking,
} from "./trade-ledger";

const USER = "user-1";
const trade = {
  accountId: "acc-1",
  action: "BUY" as const,
  quantity: 75.9878,
  date: "2026-10-15",
};

function manager(rows: unknown[] = []) {
  return { query: jest.fn(async (..._args: unknown[]) => rows) };
}

describe("findTradeInLedger", () => {
  it("is a duplicate only through a matching row no other email accounts for", async () => {
    const m = manager([
      { id: "it-1", claimed: true },
      { id: "it-2", claimed: false },
    ]);
    await expect(
      findTradeInLedger(m as never, USER, { ...trade, symbol: "XCNS" }, "r-1"),
    ).resolves.toEqual({ unclaimedId: "it-2", anyMatch: true });
  });

  it("a row another email accounts for is a second identical fill, not a duplicate", async () => {
    const m = manager([{ id: "it-1", claimed: true }]);
    await expect(
      findTradeInLedger(m as never, USER, { ...trade, symbol: "XCNS" }, "r-1"),
    ).resolves.toEqual({ unclaimedId: null, anyMatch: true });
  });

  it("matches the ticker or its listings, VOID rows excepted, and leaves this email's own row out of 'another's'", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      { ...trade, symbol: "X_NS" },
      "r-1",
    );
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("it.status != 'VOID'");
    expect(sql).toContain("r.id IS DISTINCT FROM $8::uuid");
    expect(params).toEqual([
      USER,
      "acc-1",
      "BUY",
      "2026-10-15",
      "75.9878",
      "X_NS",
      "X\\_NS.%",
      "r-1",
      null,
    ]);
  });

  it("matches the exact security when given one (the confirm, after resolution)", async () => {
    const m = manager();
    await findTradeInLedger(
      m as never,
      USER,
      { ...trade, action: "SELL", securityId: "sec-1" },
      null,
    );
    const [, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([
      USER,
      "acc-1",
      "SELL",
      "2026-10-15",
      "75.9878",
      null,
      null,
      null,
      "sec-1",
    ]);
  });
});

describe("recordTradeBooking", () => {
  it("writes the row on the request's own email, bound to the user", async () => {
    const m = manager();
    await recordTradeBooking(m as never, USER, "rq-1", "it-1");
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET investment_transaction_id = $3");
    expect(sql).toContain("r.id = q.email_receipt_id");
    expect(sql).toContain("q.user_id = $1");
    expect(params).toEqual([USER, "rq-1", "it-1"]);
  });
});

describe("emailDayOfUser", () => {
  const sent = new Date("2026-10-16T01:30:00Z");

  it("is the day in the user's timezone", async () => {
    const m = manager([
      { timezone: "America/Toronto", last_client_timezone: null },
    ]);
    await expect(emailDayOfUser(m as never, USER, sent)).resolves.toBe(
      "2026-10-15",
    );
  });

  it("falls back to the browser's last timezone, then UTC", async () => {
    let m = manager([
      { timezone: "browser", last_client_timezone: "America/Vancouver" },
    ]);
    await expect(emailDayOfUser(m as never, USER, sent)).resolves.toBe(
      "2026-10-15",
    );
    m = manager([]);
    await expect(emailDayOfUser(m as never, USER, sent)).resolves.toBe(
      "2026-10-16",
    );
  });
});
