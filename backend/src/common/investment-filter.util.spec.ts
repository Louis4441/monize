import {
  applyInvestmentTransactionFilters,
  brokerageExclusionForEntity,
  brokerageExclusionForSql,
  investmentExclusionSql,
  investmentLinkedSplitExclusion,
  investmentLinkedTransactionExclusion,
} from "./investment-filter.util";

describe("applyInvestmentTransactionFilters", () => {
  it("applies both subtype and NOT EXISTS filters with the default transaction alias", () => {
    const andWhere = jest.fn().mockReturnThis();
    const qb = { andWhere } as any;

    const result = applyInvestmentTransactionFilters(qb, "account");

    expect(result).toBe(qb);
    expect(andWhere).toHaveBeenCalledTimes(2);
    expect(andWhere.mock.calls[0][0]).toContain("account.accountSubType");
    expect(andWhere.mock.calls[0][0]).toContain("INVESTMENT_BROKERAGE");
    expect(andWhere.mock.calls[1][0]).toContain("investment_transactions");
    expect(andWhere.mock.calls[1][0]).toContain("transaction.id");
  });

  it("uses a custom transaction alias when provided", () => {
    const andWhere = jest.fn().mockReturnThis();
    const qb = { andWhere } as any;

    applyInvestmentTransactionFilters(qb, "acc", "tx");

    expect(andWhere.mock.calls[1][0]).toContain("tx.id");
    expect(andWhere.mock.calls[1][0]).not.toContain("transaction.id");
  });

  it("is composed from the exported fragments, not a second copy of them", () => {
    const andWhere = jest.fn().mockReturnThis();
    const qb = { andWhere } as any;

    applyInvestmentTransactionFilters(qb, "acc", "tx");

    expect(andWhere.mock.calls[0][0]).toBe(brokerageExclusionForEntity("acc"));
    expect(andWhere.mock.calls[1][0]).toBe(
      investmentLinkedTransactionExclusion("tx"),
    );
  });
});

describe("brokerage exclusion dialects", () => {
  it("differ only in the column name", () => {
    expect(brokerageExclusionForEntity("a")).toBe(
      "(a.accountSubType IS NULL OR a.accountSubType != 'INVESTMENT_BROKERAGE')",
    );
    expect(brokerageExclusionForSql("a")).toBe(
      "(a.account_sub_type IS NULL OR a.account_sub_type != 'INVESTMENT_BROKERAGE')",
    );
    expect(
      brokerageExclusionForEntity("a").replace(/accountSubType/g, "SUBTYPE"),
    ).toBe(
      brokerageExclusionForSql("a").replace(/account_sub_type/g, "SUBTYPE"),
    );
  });

  // A NULL sub-type is a standalone investment account -- it IS its own cash
  // side, so it must survive the filter.
  it("keeps a NULL sub-type in scope", () => {
    expect(brokerageExclusionForSql("a")).toContain("IS NULL OR");
  });
});

describe("investmentExclusionSql", () => {
  it("emits the brokerage, transaction and split clauses when all aliases are given", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
      splitAlias: "ts",
    });

    expect(sql).toContain(brokerageExclusionForSql("a"));
    expect(sql).toContain(investmentLinkedTransactionExclusion("t"));
    expect(sql).toContain(investmentLinkedSplitExclusion("ts"));
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(2);
  });

  it("omits the split clause when the query joins no splits", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
    });

    expect(sql).not.toContain("transaction_split_id");
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(1);
  });

  it("omits the brokerage clause when no account alias is given", () => {
    const sql = investmentExclusionSql({ transactionAlias: "t" });

    expect(sql).not.toContain("account_sub_type");
    expect(sql).toBe(investmentLinkedTransactionExclusion("t"));
  });

  it("carries no bound parameters, so a caller's $n numbering is unchanged", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
      splitAlias: "ts",
    });

    expect(sql).not.toMatch(/\$\d/);
  });

  it("joins its clauses with AND", () => {
    const sql = investmentExclusionSql({
      accountAlias: "a",
      transactionAlias: "t",
      splitAlias: "ts",
    });

    expect(sql.match(/\bAND\b/g)).toHaveLength(2);
  });

  it("uses distinct sub-query aliases so both NOT EXISTS clauses can coexist", () => {
    expect(investmentLinkedTransactionExclusion("t")).toContain(
      "investment_transactions it ",
    );
    expect(investmentLinkedSplitExclusion("ts")).toContain(
      "investment_transactions its ",
    );
  });
});
