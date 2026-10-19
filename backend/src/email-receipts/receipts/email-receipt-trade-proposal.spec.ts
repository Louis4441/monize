import { readTradeProposal } from "./email-receipt-trade-proposal";

const preview = {
  accountName: "CA RRSP - Brokerage",
  transactionDate: "2026-10-15",
  investmentAction: "BUY",
  symbol: "XCNS",
  securityName: "iShares Core Conservative Balanced ETF Portfolio",
  securityCurrency: "CAD",
  quantity: 75.9878,
  price: 26.3200145286,
  commission: 0,
  totalAmount: 2000,
};

const stored = (over: Record<string, unknown> = {}) => ({
  trade: {},
  action: { preview: { ...preview, ...over } },
  proposedAt: "2026-10-16T02:00:00.000Z",
});

describe("readTradeProposal", () => {
  it("reads the card's preview, a zero commission included", () => {
    expect(readTradeProposal(stored())).toEqual({
      accountName: "CA RRSP - Brokerage",
      date: "2026-10-15",
      action: "BUY",
      symbol: "XCNS",
      securityName: "iShares Core Conservative Balanced ETF Portfolio",
      quantity: 75.9878,
      price: 26.3200145286,
      commission: 0,
      totalAmount: 2000,
      currencyCode: "CAD",
    });
  });

  it("keeps a missing security name as null", () => {
    expect(
      readTradeProposal(stored({ securityName: null }))?.securityName,
    ).toBeNull();
  });

  it.each([null, undefined, "x", [], {}, { action: null }, { action: {} }])(
    "is null for a proposal with no preview (%p)",
    (value) => {
      expect(readTradeProposal(value)).toBeNull();
    },
  );

  it.each([
    ["investmentAction", "INTEREST"],
    ["accountName", ""],
    ["transactionDate", null],
    ["symbol", 5],
    ["securityCurrency", undefined],
    ["quantity", "75.9878"],
    ["price", Number.NaN],
    ["totalAmount", null],
    ["commission", undefined],
  ])("is null when %s is %p: a partial trade is no trade", (field, value) => {
    expect(readTradeProposal(stored({ [field]: value }))).toBeNull();
  });

  it("reads a reinvested dividend like a buy", () => {
    expect(
      readTradeProposal(stored({ investmentAction: "REINVEST" }))?.action,
    ).toBe("REINVEST");
    expect(
      readTradeProposal(stored({ investmentAction: "REINVEST", price: null })),
    ).toBeNull();
  });

  it("reads a cash dividend paid as one amount, with no shares and no price", () => {
    expect(
      readTradeProposal(
        stored({
          investmentAction: "DIVIDEND",
          quantity: null,
          price: null,
          totalAmount: 12.34,
        }),
      ),
    ).toMatchObject({
      action: "DIVIDEND",
      quantity: null,
      price: null,
      totalAmount: 12.34,
    });
  });
});
