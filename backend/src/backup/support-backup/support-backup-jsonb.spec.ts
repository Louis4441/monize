import { applyJsonbHandler } from "./support-backup-jsonb";

const M = 2;

describe("JSONB handlers", () => {
  it("transferRules masks pattern and account name, keeps type, drops foreign keys", () => {
    const out = applyJsonbHandler(
      "transferRules",
      [
        {
          type: "payee",
          pattern: "AMZ Marketplace",
          accountName: "Chequing",
          secret: "leak",
        },
      ],
      M,
    ) as Record<string, unknown>[];
    expect(out[0].type).toBe("payee");
    expect(out[0].pattern).toBe("AM***********ce");
    expect(out[0].accountName).toBe("Ch****ng");
    expect(out[0]).not.toHaveProperty("secret");
  });

  it("overrideSplits scales amount, keeps categoryId, drops memo and foreign keys", () => {
    const out = applyJsonbHandler(
      "overrideSplits",
      [{ categoryId: "cat-1", amount: 100, memo: "rent", extra: 1 }],
      M,
    ) as Record<string, unknown>[];
    expect(out[0].categoryId).toBe("cat-1");
    expect(out[0].amount).toBe(200);
    expect(out[0]).not.toHaveProperty("memo");
    expect(out[0]).not.toHaveProperty("extra");
  });

  it("lumpSums scales amount, keeps date and mode", () => {
    const out = applyJsonbHandler(
      "lumpSums",
      [
        {
          date: "2026-06-01",
          amount: 5000,
          mode: "SHORTEN_TERM",
          note: "bonus",
        },
      ],
      M,
    ) as Record<string, unknown>[];
    expect(out[0]).toEqual({
      date: "2026-06-01",
      amount: 10000,
      mode: "SHORTEN_TERM",
    });
  });

  it("assetWeightings masks the class name, keeps the weight, drops foreign keys", () => {
    const out = applyJsonbHandler(
      "assetWeightings",
      [{ name: "Fixed Income", weight: 0.4, note: "from prospectus" }],
      M,
    ) as Record<string, unknown>[];
    expect(out[0].name).toBe("Fi********me");
    // The weight is a share of the fund, not a private money amount, so the
    // multiplier must not touch it.
    expect(out[0].weight).toBe(0.4);
    expect(out[0]).not.toHaveProperty("note");
  });

  it("assetWeightings returns an empty array for a non-array value", () => {
    expect(applyJsonbHandler("assetWeightings", null, M)).toEqual([]);
    expect(applyJsonbHandler("assetWeightings", [42], M)).toEqual([{}]);
  });

  it("reportFilters keeps id arrays, drops searchText and foreign keys", () => {
    const out = applyJsonbHandler(
      "reportFilters",
      {
        accountIds: ["a"],
        categoryIds: ["c"],
        payeeIds: ["p"],
        searchText: "salary",
        odd: 1,
      },
      M,
    ) as Record<string, unknown>;
    expect(out).toEqual({
      accountIds: ["a"],
      categoryIds: ["c"],
      payeeIds: ["p"],
    });
  });

  it("gemMomentum keeps every role's return untouched and drops foreign keys", () => {
    const out = applyJsonbHandler(
      "gemMomentum",
      {
        US_EQUITY: 12.5,
        EX_US_EQUITY: -3.25,
        EM_EQUITY: null,
        SAFE: 1.1,
        RISK_FREE: 0.4,
        NEW_ROLE: 9,
      },
      M,
    ) as Record<string, unknown>;
    // Returns in percent, not amounts -- the multiplier must not touch them,
    // and the figures a decision was taken on must survive verbatim.
    expect(out).toEqual({
      US_EQUITY: 12.5,
      EX_US_EQUITY: -3.25,
      EM_EQUITY: null,
      SAFE: 1.1,
      RISK_FREE: 0.4,
    });
  });

  it("gemMomentum returns an empty object for a non-object value", () => {
    expect(applyJsonbHandler("gemMomentum", null, M)).toEqual({});
    expect(applyJsonbHandler("gemMomentum", [1, 2], M)).toEqual({});
  });
});
