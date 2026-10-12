import { parseTransactionSearch } from "./transaction-search-query.util";
import {
  buildTransactionSearchClause,
  buildTransactionSearchWhere,
  escapeLikePattern,
  hasAttachmentSql,
  referenceKey,
  referenceKeySql,
  SearchClauseOptions,
  splitExistsSql,
  uncategorizedSql,
} from "./transaction-search.util";

describe("escapeLikePattern", () => {
  it("escapes backslash, percent, and underscore", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("returns plain text unchanged", () => {
    expect(escapeLikePattern("groceries")).toBe("groceries");
  });
});

describe("buildTransactionSearchClause", () => {
  it("matches all the user-visible transaction fields", () => {
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    // Existing fields
    expect(clause).toContain("transaction.description ILIKE :search");
    expect(clause).toContain("transaction.payeeName ILIKE :search");
    expect(clause).toContain("transaction.referenceNumber ILIKE :search");
    expect(clause).toContain("splits.memo ILIKE :search");

    // New fields
    expect(clause).toContain("CAST(transaction.amount AS TEXT) ILIKE :search");
    expect(clause).toContain("CAST(splits.amount AS TEXT) ILIKE :search");
    expect(clause).toMatch(
      /EXISTS \(SELECT 1 FROM payees [^)]*name ILIKE :search\)/,
    );
    expect(clause).toMatch(
      /EXISTS \(SELECT 1 FROM categories [^)]*transaction\.category_id[^)]*name ILIKE :search\)/,
    );
    expect(clause).toMatch(
      /EXISTS \(SELECT 1 FROM categories [^)]*splits\.category_id[^)]*name ILIKE :search\)/,
    );
    expect(clause).toContain("transaction_tags");
    expect(clause).toContain("transaction_split_tags");
  });

  it("matches a transfer leg by its counterpart account's name (issue #1214)", () => {
    // A blank-payee transfer displays "Transfer to/from <counterpart>"
    // resolved at read time, so searching the counterpart's name has to find
    // the leg the way searching the stamped payee text used to.
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    expect(clause).toContain(
      "EXISTS (SELECT 1 FROM transactions search_lt JOIN accounts search_la ON search_la.id = search_lt.account_id WHERE search_lt.id = transaction.linked_transaction_id AND transaction.is_transfer = true AND search_la.name ILIKE :search)",
    );
  });

  it("emits guarded, cast exact-amount terms for parent and split", () => {
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    expect(clause).toContain(
      "(CAST(:searchAmount AS numeric) IS NOT NULL AND ABS(transaction.amount) = ABS(CAST(:searchAmount AS numeric)))",
    );
    expect(clause).toContain(
      "(CAST(:searchAmount AS numeric) IS NOT NULL AND ABS(splits.amount) = ABS(CAST(:searchAmount AS numeric)))",
    );
  });

  it("emits a guarded, cast exact-date term", () => {
    const clause = buildTransactionSearchClause({
      transaction: "transaction",
      splits: "splits",
    });

    expect(clause).toContain(
      "(CAST(:searchDate AS date) IS NOT NULL AND transaction.transactionDate = CAST(:searchDate AS date))",
    );
  });

  it("respects custom alias and parameter names", () => {
    const clause = buildTransactionSearchClause({
      transaction: "bf",
      splits: "bfSplits",
      paramName: "bfSearch",
    });

    expect(clause).toContain("bf.description ILIKE :bfSearch");
    expect(clause).toContain("bfSplits.memo ILIKE :bfSearch");
    expect(clause).toContain("bf.payee_id");
    expect(clause).toContain("bf.category_id");
    expect(clause).toContain("bfSplits.category_id");
    expect(clause).toContain("bf.id");
    expect(clause).toContain("bfSplits.id");
    expect(clause).not.toContain(":search");
  });

  it("derives amount/date param names from the search param name", () => {
    const clause = buildTransactionSearchClause({
      transaction: "bf",
      splits: "bfSplits",
      paramName: "bfSearch",
    });

    expect(clause).toContain(":bfSearchAmount");
    expect(clause).toContain(":bfSearchDate");
    expect(clause).not.toContain(":searchAmount");
    expect(clause).not.toContain(":searchDate");
  });

  it("honours explicit amount/date param name overrides", () => {
    const clause = buildTransactionSearchClause({
      transaction: "t",
      splits: "s",
      amountParamName: "amtParam",
      dateParamName: "dateParam",
    });

    expect(clause).toContain("ABS(CAST(:amtParam AS numeric))");
    expect(clause).toContain("CAST(:dateParam AS date)");
  });
});

describe("buildTransactionSearchWhere", () => {
  const EN = { numberFormat: "en-US", dateFormat: "YYYY-MM-DD" };
  const TX: SearchClauseOptions = {
    transaction: "transaction",
    grain: "transaction",
    paramPrefix: "srch",
  };
  const SPLIT: SearchClauseOptions = {
    transaction: "t",
    splits: "ts",
    grain: "split",
    paramPrefix: "srch",
  };

  function build(input: string, options: SearchClauseOptions = TX) {
    const clause = buildTransactionSearchWhere(
      parseTransactionSearch(input, EN).terms,
      options,
    );
    if (!clause) throw new Error(`no clause for ${input}`);
    return clause;
  }

  it("returns null for no terms and for only empty terms", () => {
    expect(buildTransactionSearchWhere([], TX)).toBeNull();
    expect(
      buildTransactionSearchWhere(
        parseTransactionSearch('ref: "" #""', EN).terms,
        TX,
      ),
    ).toBeNull();
  });

  it("ANDs one COALESCE-wrapped condition per term", () => {
    const { sql } = build("costco gas");
    expect(sql.startsWith("(COALESCE(")).toBe(true);
    expect(sql.split(") AND COALESCE(").length).toBe(2);
  });

  it("negates outside the COALESCE so a null column keeps the row", () => {
    const { sql } = build("-memo:rent");
    expect(sql).toMatch(/^\(NOT COALESCE\(/);
    expect(sql).toContain(", FALSE)");
  });

  it("skips an empty term but keeps the others", () => {
    const { sql, params } = build("ref: costco");
    expect(Object.values(params)).toEqual(["%costco%"]);
    expect(sql.split("COALESCE(").length - 1).toBe(1);
  });

  describe("bare terms keep today's arms", () => {
    it("binds the escaped contains pattern once and reuses it", () => {
      const { sql, params } = build("50%_off");
      expect(params).toEqual({ srch0: "%50\\%\\_off%" });
      for (const arm of [
        "transaction.description ILIKE :srch0",
        "transaction.payeeName ILIKE :srch0",
        "transaction.referenceNumber ILIKE :srch0",
        "CAST(transaction.amount AS TEXT) ILIKE :srch0",
        "search_sx.memo ILIKE :srch0",
        "CAST(search_sx.amount AS TEXT) ILIKE :srch0",
        "search_p.name ILIKE :srch0",
        "search_la.name ILIKE :srch0",
        "search_c.name ILIKE :srch0",
        "search_sc.name ILIKE :srch0",
        "search_tg.name ILIKE :srch0",
        "search_stg.name ILIKE :srch0",
      ]) {
        expect(sql).toContain(arm);
      }
      expect(sql).not.toContain("search_a.name");
    });

    it("adds the amount arms only when the term reads as an amount", () => {
      const { sql, params } = build("-12.34");
      expect(params.srch1).toBe(12.34);
      expect(sql).toContain(
        "ABS(transaction.amount) = CAST(:srch1 AS numeric)",
      );
      expect(sql).toContain("ABS(search_sx.amount) = CAST(:srch1 AS numeric)");
      expect(build("groceries").sql).not.toContain("ABS(");
    });

    it("adds the date arm only when the term reads as a date", () => {
      const { sql, params } = build("2026-03-15");
      expect(Object.values(params)).toContain("2026-03-15");
      expect(sql).toMatch(
        /transaction\.transactionDate = CAST\(:srch\d AS date\)/,
      );
      expect(build("groceries").sql).not.toContain("transactionDate");
    });
  });

  describe("grain", () => {
    it("correlates split arms to any split of the transaction", () => {
      expect(build("memo:rent").sql).toContain(
        "EXISTS (SELECT 1 FROM transaction_splits search_sx WHERE search_sx.transaction_id = transaction.id AND (search_sx.memo ILIKE :srch0))",
      );
    });

    it("correlates split arms to the row's own split at split grain", () => {
      expect(build("memo:rent", SPLIT).sql).toContain(
        "EXISTS (SELECT 1 FROM transaction_splits search_sx WHERE search_sx.id = ts.id AND (search_sx.memo ILIKE :srch0))",
      );
    });

    it("refuses a split grain without the split alias", () => {
      expect(() =>
        build("rent", { transaction: "t", grain: "split", paramPrefix: "p" }),
      ).toThrow();
    });
  });

  describe("text operators", () => {
    it("contains, exact and glob on a text field", () => {
      expect(build("payee:cost").params).toEqual({ srch0: "%cost%" });
      const exact = build('payee:=" Costco "');
      expect(exact.params).toEqual({ srch0: "Costco" });
      expect(exact.sql).toContain("btrim(transaction.payeeName) ILIKE :srch0");
      const glob = build("payee:*hydro_1*");
      expect(glob.params).toEqual({ srch0: "%hydro\\_1%" });
      expect(glob.sql).toContain("transaction.payeeName ILIKE :srch0");
    });

    it.each([
      ["payee:x", ["transaction.payeeName", "search_p.name", "search_la.name"]],
      ["memo:x", ["transaction.description", "search_sx.memo"]],
      ["cat:x", ["search_c.name", "search_sc.name"]],
      ["tag:x", ["search_tg.name", "search_stg.name"]],
      ["account:x", ["search_a.name"]],
      ["ref:x", ["transaction.referenceNumber"]],
    ])("%s reads only its own columns", (input, columns) => {
      const { sql } = build(input);
      const all = [
        "transaction.payeeName",
        "search_p.name",
        "search_la.name",
        "transaction.description",
        "search_sx.memo",
        "search_c.name",
        "search_sc.name",
        "search_tg.name",
        "search_stg.name",
        "search_a.name",
        "transaction.referenceNumber",
      ];
      for (const column of all) {
        expect(sql.includes(`${column} ILIKE`)).toBe(columns.includes(column));
      }
    });

    it("compares an exact reference through the reference key", () => {
      const { sql, params } = build("#0010");
      expect(params).toEqual({ srch0: "10" });
      expect(sql).toContain(
        `${referenceKeySql("transaction.referenceNumber")} = :srch0`,
      );
    });

    it("globs a reference on the raw column", () => {
      const { sql, params } = build("ref:10*");
      expect(params).toEqual({ srch0: "10%" });
      expect(sql).toContain("transaction.referenceNumber ILIKE :srch0");
    });
  });

  describe("enum fields", () => {
    it("binds the stored status value", () => {
      const { sql, params } = build("status:void");
      expect(params).toEqual({ srch0: "VOID" });
      expect(sql).toContain("transaction.status = :srch0");
    });

    it.each([
      ["is:transfer", "transaction.is_transfer = true"],
      ["is:split", "transaction.is_split = true"],
      ["is:uncategorized", uncategorizedSql(TX)],
      ["has:attachment", hasAttachmentSql("transaction")],
      ["has:ref", "NULLIF(btrim(transaction.referenceNumber), '') IS NOT NULL"],
      ["has:memo", "NULLIF(btrim(search_sx.memo), '') IS NOT NULL"],
      [
        "has:tag",
        "transaction_split_tags search_stt WHERE search_stt.transaction_split_id = search_sx.id",
      ],
    ])("%s", (input, fragment) => {
      expect(build(input).sql).toContain(fragment);
    });
  });

  describe("amount and date", () => {
    it("amount equality reads the total and the split lines", () => {
      const { sql, params } = build("amount:20");
      expect(params).toEqual({ srch0: 20 });
      expect(sql).toContain(
        "ABS(transaction.amount) = CAST(:srch0 AS numeric)",
      );
      expect(sql).toContain("ABS(search_sx.amount) = CAST(:srch0 AS numeric)");
    });

    it.each([
      ["amount:>90", "ABS(transaction.amount) > CAST(:srch0 AS numeric)"],
      ["amount:<=90", "ABS(transaction.amount) <= CAST(:srch0 AS numeric)"],
      [
        "amount:50..100",
        "ABS(transaction.amount) BETWEEN CAST(:srch0 AS numeric) AND CAST(:srch1 AS numeric)",
      ],
      ["date:2026-03-15", "transaction.transactionDate = CAST(:srch0 AS date)"],
      [
        "date:2026-03",
        "transaction.transactionDate BETWEEN CAST(:srch0 AS date) AND CAST(:srch1 AS date)",
      ],
      ["date:>=2026-03", "transaction.transactionDate >= CAST(:srch0 AS date)"],
    ])("%s compares the total only", (input, fragment) => {
      const { sql } = build(input);
      expect(sql).toContain(fragment);
      expect(sql).not.toContain("search_sx");
    });
  });

  it("names parameters by prefix so two searches in one query never collide", () => {
    const a = build("costco amount:>5", { ...TX, paramPrefix: "a" });
    const b = build("costco amount:>5", { ...TX, paramPrefix: "b" });
    const names = [...Object.keys(a.params), ...Object.keys(b.params)];
    expect(new Set(names).size).toBe(names.length);
    expect(a.sql).not.toContain(":b");
  });
});

describe("referenceKey", () => {
  it.each([
    ["10", "10"],
    ["0010", "10"],
    ["#10", "10"],
    ["#0010", "10"],
    ["  10 ", "10"],
    ["A10", "a10"],
    ["a010", "a010"],
    ["0", "0"],
    ["000", "0"],
    ["#", ""],
    ["##10", "#10"],
  ])("%j -> %j", (input, key) => {
    expect(referenceKey(input)).toBe(key);
  });
});

describe("splitExistsSql", () => {
  it("is null with no conditions", () => {
    expect(
      splitExistsSql({ transaction: "t", grain: "transaction" }, []),
    ).toBeNull();
  });
});
