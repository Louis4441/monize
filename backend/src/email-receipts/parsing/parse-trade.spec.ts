import {
  parseTradeAction,
  parseTradeDate,
  parseTradeLines,
  parseTradeLinesTraced,
  parseTradeQuantity,
  resolveTradeAccountId,
  tradeIsConsistent,
} from "./parse-trade";
import { normalizeReceiptLines } from "./receipt-lines";
import { validateReceiptParserDefinition } from "./receipt-parser.validation";
import {
  WEALTHSIMPLE_BUY_BODY,
  WEALTHSIMPLE_RRSP_ACCOUNT_ID,
  WEALTHSIMPLE_TFSA_ACCOUNT_ID,
  WEALTHSIMPLE_TRADE_DEFINITION,
} from "./fixtures/wealthsimple-trade";
import type { ReceiptTradeDefinition } from "./receipt-parser.types";

const trade = WEALTHSIMPLE_TRADE_DEFINITION.trade as ReceiptTradeDefinition;
const lines = (body: string): string[] => normalizeReceiptLines(body);

describe("parseTradeLines", () => {
  it("reads a Wealthsimple fractional buy completely", () => {
    const parsed = parseTradeLines(trade, lines(WEALTHSIMPLE_BUY_BODY));
    expect(parsed).toEqual({
      action: "BUY",
      symbol: "XCNS",
      quantity: 75.9878,
      total: 20_000_000,
      price: 263_200,
      commission: null,
      date: "2026-10-15",
      accountText: "RRSP",
      accountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID,
      complete: true,
      consistent: true,
      reason: null,
    });
  });

  it("chooses the account by the printed account text", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace(
      "Account: RRSP",
      "Account: TFSA",
    );
    expect(parseTradeLines(trade, lines(body)).accountId).toBe(
      WEALTHSIMPLE_TFSA_ACCOUNT_ID,
    );
  });

  it("reads a sell", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace("Fractional Buy", "Sell");
    expect(parseTradeLines(trade, lines(body)).action).toBe("SELL");
  });

  it.each([
    ["trade_no_action", "Type: Fractional Buy", "Type: Transfer"],
    ["trade_no_symbol", "Symbol: XCNS", "Ticker: XCNS"],
    ["trade_no_quantity", "Shares: 75.9878", "Shares: many"],
    ["trade_no_account", "Account: RRSP", "Account: Margin"],
  ])("is incomplete with %s", (reason, from, to) => {
    const parsed = parseTradeLines(
      trade,
      lines(WEALTHSIMPLE_BUY_BODY.replace(from, to)),
    );
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe(reason);
  });

  it("is incomplete without an amount", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace(
      "Total cost: $2,000.00\n",
      "",
    ).replace("Average price: $26.32\n", "");
    expect(parseTradeLines(trade, lines(body)).reason).toBe("trade_no_amount");
  });

  it("reads a trade with only a total (no cross-check possible)", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace("Average price: $26.32\n", "");
    const parsed = parseTradeLines(trade, lines(body));
    expect(parsed.complete).toBe(true);
    expect(parsed.consistent).toBeNull();
  });

  it("flags a price that does not fit the total", () => {
    const body = WEALTHSIMPLE_BUY_BODY.replace("$26.32", "$31.00");
    const parsed = parseTradeLines(trade, lines(body));
    expect(parsed.complete).toBe(true);
    expect(parsed.consistent).toBe(false);
  });

  it("uses the default account when the text matches no rule", () => {
    const withDefault: ReceiptTradeDefinition = {
      ...trade,
      defaultAccountId: WEALTHSIMPLE_TFSA_ACCOUNT_ID,
    };
    const body = WEALTHSIMPLE_BUY_BODY.replace(
      "Account: RRSP",
      "Account: Margin",
    );
    expect(parseTradeLines(withDefault, lines(body)).accountId).toBe(
      WEALTHSIMPLE_TFSA_ACCOUNT_ID,
    );
  });

  it("traces the lines that read each value", () => {
    const { trace } = parseTradeLinesTraced(
      trade,
      lines(WEALTHSIMPLE_BUY_BODY),
    );
    expect(trace.symbol?.line.text).toBe("Symbol: XCNS");
    expect(trace.quantity?.pattern).toBe("Shares: {quantity}");
    expect(trace.commission).toBeNull();
  });
});

describe("trade value readers", () => {
  it("reads share counts with up to 8 decimals", () => {
    expect(parseTradeQuantity("75.9878")?.value).toBe(75.9878);
    expect(parseTradeQuantity("1,250.5")?.value).toBe(1250.5);
    expect(parseTradeQuantity("0.00000001")?.units).toBe(1n);
  });

  it.each(["", "0", "-5", "1e3", "1.2.3", "12.123456789", "abc", "5 shares"])(
    "refuses the share count %p",
    (text) => {
      expect(parseTradeQuantity(text)).toBeNull();
    },
  );

  it("reads the direction from the words", () => {
    expect(parseTradeAction("Fractional Buy")).toBe("BUY");
    expect(parseTradeAction("Market sell")).toBe("SELL");
    expect(parseTradeAction("Buy to cover sell")).toBeNull();
    expect(parseTradeAction("Dividend")).toBeNull();
  });

  it("reads the broker's local day and ignores the time", () => {
    expect(parseTradeDate("October 15, 2026 12:04 EDT")).toBe("2026-10-15");
    expect(parseTradeDate("Oct. 3rd 2026")).toBe("2026-10-03");
    expect(parseTradeDate("Dec 3, 2026")).toBe("2026-12-03");
    expect(parseTradeDate("2026-02-28 09:00")).toBe("2026-02-28");
    expect(parseTradeDate("February 30, 2026")).toBeNull();
    expect(parseTradeDate("no date here")).toBeNull();
  });

  it("allows the rounding of a written price and one cent, no more", () => {
    const base = {
      action: "BUY" as const,
      quantityUnits: 7_598_780_000n,
      priceUnits: 263_200,
      priceDecimals: 2,
      totalUnits: 20_000_000,
      commissionUnits: 0,
    };
    expect(tradeIsConsistent(base)).toBe(true);
    expect(tradeIsConsistent({ ...base, totalUnits: 20_500_000 })).toBe(false);
  });

  it("takes a buy's commission out of the total and a sell's into it", () => {
    // 10 shares at 10.00 is 100.00; commission 9.99.
    const shares = 1_000_000_000n;
    const common = {
      quantityUnits: shares,
      priceUnits: 100_000,
      priceDecimals: 2,
      commissionUnits: 99_900,
    };
    expect(
      tradeIsConsistent({ ...common, action: "BUY", totalUnits: 1_099_900 }),
    ).toBe(true);
    expect(
      tradeIsConsistent({ ...common, action: "BUY", totalUnits: 1_000_000 }),
    ).toBe(false);
    expect(
      tradeIsConsistent({ ...common, action: "SELL", totalUnits: 900_100 }),
    ).toBe(true);
  });

  it("falls back to the default account without an account text", () => {
    expect(
      resolveTradeAccountId(
        { defaultAccountId: WEALTHSIMPLE_RRSP_ACCOUNT_ID },
        null,
      ),
    ).toBe(WEALTHSIMPLE_RRSP_ACCOUNT_ID);
    expect(resolveTradeAccountId({}, "RRSP")).toBeNull();
  });
});

describe("validating a trade profile", () => {
  const valid = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(WEALTHSIMPLE_TRADE_DEFINITION));
  const codes = (input: unknown): string[] => {
    const result = validateReceiptParserDefinition(input);
    return result.ok ? [] : result.errors.map((e) => `${e.path}:${e.code}`);
  };

  it("accepts the Wealthsimple profile unchanged", () => {
    const result = validateReceiptParserDefinition(valid());
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.definition).toEqual(WEALTHSIMPLE_TRADE_DEFINITION);
  });

  it("refuses a receipt field beside the trade section", () => {
    expect(codes({ ...valid(), total: ["Total: {amount}"] })).toContain(
      "total:trade_conflict",
    );
  });

  it("requires action, symbol and quantity", () => {
    const input = valid();
    delete (input.trade as Record<string, unknown>).symbol;
    expect(codes(input)).toContain("trade.symbol:empty");
  });

  it("requires a total or a price", () => {
    const input = valid();
    const section = input.trade as Record<string, unknown>;
    delete section.total;
    delete section.price;
    expect(codes(input)).toContain("trade.total:trade_amount_missing");
  });

  it("requires a decidable account", () => {
    const input = valid();
    delete (input.trade as Record<string, unknown>).accountRules;
    expect(codes(input)).toContain(
      "trade.defaultAccountId:trade_account_missing",
    );
  });

  it("refuses account rules with a bad id, a capture or an unknown key", () => {
    const input = valid();
    (input.trade as Record<string, unknown>).accountRules = [
      { match: "R{x}", accountId: "nope", extra: 1 },
    ];
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        "trade.accountRules[0].accountId:invalid_uuid",
        "trade.accountRules[0].extra:unknown_key",
      ]),
    );
  });

  it("refuses the wrong capture in a field", () => {
    const input = valid();
    (input.trade as Record<string, unknown>).symbol = ["Symbol: {amount}"];
    expect(codes(input)).toEqual(
      expect.arrayContaining(["trade.symbol[0]:capture_not_allowed"]),
    );
  });
});
