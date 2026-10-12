import { TestingModule } from "@nestjs/testing";
import { DataSource, SelectQueryBuilder } from "typeorm";

import { Account } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { applyParsedSearch } from "@/transactions/apply-transaction-search";
import { parseSearchTerm } from "@/transactions/transaction-search-parse.util";
import { parseTransactionSearch } from "@/transactions/transaction-search-query.util";
import {
  buildTransactionSearchClause,
  escapeLikePattern,
  referenceKey,
  referenceKeySql,
  SearchGrain,
} from "@/transactions/transaction-search.util";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * The search clause builder against real PostgreSQL: the truth tables of
 * `docs/future-plans/advanced-search.md` section 8 at both grains, the
 * reference key's SQL against its TypeScript twin, and INV-SEARCH-002 --
 * a single bare term finds exactly the transactions the single-term clause
 * every call site uses today finds.
 *
 * The queries here are plain query builders shaped like the two grains the
 * call sites use (a transaction query; a transaction joined to its splits),
 * not the call sites themselves; task B3 adds the call-site cases when it
 * moves them onto the helper.
 */
describe("transaction search (integration)", () => {
  const EN = { numberFormat: "en-US", dateFormat: "YYYY-MM-DD" };

  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let refAccount: Account;
  let splitAccount: Account;
  /** Transaction id -> fixture label. */
  const labels = new Map<string, string>();
  /** Split id -> fixture label ("S/Gas"). */
  const splitLabels = new Map<string, string>();

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);

    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "categories",
      "accounts",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    refAccount = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      currencyCode: "USD",
    });
    splitAccount = await createTestAccount(dataSource, userId, {
      name: "Visa",
      currencyCode: "USD",
    });
    const groceries = await createTestCategory(dataSource, userId, {
      name: "Groceries",
    });
    const gas = await createTestCategory(dataSource, userId, { name: "Gas" });

    const save = async (
      label: string,
      fields: Partial<Transaction>,
    ): Promise<Transaction> => {
      const row = await dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          currencyCode: "USD",
          transactionDate: "2026-03-10",
          ...fields,
        }),
      );
      labels.set(row.id, label);
      return row;
    };

    // Section 8, references.
    await save("A", {
      accountId: refAccount.id,
      referenceNumber: "10",
      amount: -50,
      transactionDate: "2026-03-15",
    });
    await save("B", {
      accountId: refAccount.id,
      referenceNumber: "100",
      amount: -75,
    });
    await save("C", {
      accountId: refAccount.id,
      referenceNumber: "0010",
      amount: -20,
    });
    await save("D", {
      accountId: refAccount.id,
      referenceNumber: "A10",
      amount: -30,
    });
    await save("E", { accountId: refAccount.id, amount: -10 });
    await save("F", {
      accountId: refAccount.id,
      amount: -40,
      description: "Invoice 10",
    });

    // Section 8, words and splits.
    const s = await save("S", {
      accountId: splitAccount.id,
      payeeName: "Costco",
      amount: -100,
      isSplit: true,
    });
    for (const [label, categoryId, amount] of [
      ["S/Groceries", groceries.id, -80],
      ["S/Gas", gas.id, -20],
    ] as const) {
      const split = await dataSource.manager.save(
        dataSource.manager.create(TransactionSplit, {
          transactionId: s.id,
          categoryId,
          amount,
        }),
      );
      splitLabels.set(split.id, label);
    }
    await save("P", {
      accountId: splitAccount.id,
      payeeName: "Costco Gas Bar",
      categoryId: gas.id,
      amount: -60,
    });
  });

  afterAll(async () => {
    await module.close();
  });

  function transactionQuery(
    alias: string,
    accountId: string,
  ): SelectQueryBuilder<Transaction> {
    return dataSource
      .getRepository(Transaction)
      .createQueryBuilder(alias)
      .select(`${alias}.id`, "id")
      .where(`${alias}.userId = :userId`, { userId })
      .andWhere(`${alias}.accountId = :accountId`, { accountId });
  }

  async function transactionsMatching(
    input: string,
    accountId: string,
    alias = "transaction",
  ): Promise<string[]> {
    const qb = transactionQuery(alias, accountId);
    applyParsedSearch(qb, parseTransactionSearch(input, EN), {
      transaction: alias,
      grain: "transaction",
      paramPrefix: "srch",
    });
    const rows: Array<{ id: string }> = await qb.getRawMany();
    return rows.map((row) => labels.get(row.id) as string).sort();
  }

  /** Rows of a transaction joined to its splits; a row with no split is its transaction's label. */
  async function splitRowsMatching(input: string): Promise<string[]> {
    const qb = dataSource
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .leftJoin("t.splits", "ts")
      .select("t.id", "tid")
      .addSelect("ts.id", "sid")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :accountId", { accountId: splitAccount.id });
    applyParsedSearch(qb, parseTransactionSearch(input, EN), {
      transaction: "t",
      splits: "ts",
      grain: "split" satisfies SearchGrain,
      paramPrefix: "srch",
    });
    const rows: Array<{ tid: string; sid: string | null }> =
      await qb.getRawMany();
    return rows
      .map((row) =>
        row.sid
          ? (splitLabels.get(row.sid) as string)
          : (labels.get(row.tid) as string),
      )
      .sort();
  }

  describe("references (plan section 8)", () => {
    it.each<[string, string[]]>([
      ["10", ["A", "B", "C", "D", "E", "F"]],
      ["ref:10", ["A", "B", "C", "D"]],
      ["ref:=10", ["A", "C"]],
      ["#10", ["A", "C"]],
      ["#0010", ["A", "C"]],
      ["ref:10*", ["A", "B"]],
      ["has:ref -ref:=10", ["B", "D"]],
      ["amount:=10", ["E"]],
      ["memo:10", ["F"]],
      ["ref:", ["A", "B", "C", "D", "E", "F"]],
      ["date:2026-03-15", ["A"]],
      ["date:2026-03", ["A", "B", "C", "D", "E", "F"]],
      ["date:<2026-03-15", ["B", "C", "D", "E", "F"]],
      ["amount:20..50", ["A", "C", "D", "F"]],
      ["-memo:invoice", ["A", "B", "C", "D", "E"]],
      ["is:uncategorized", ["A", "B", "C", "D", "E", "F"]],
      ["status:unreconciled", ["A", "B", "C", "D", "E", "F"]],
      ["has:attachment", []],
      ["account:chequing", ["A", "B", "C", "D", "E", "F"]],
      ["10 -account:chequing", []],
    ])("%j", async (input, expected) => {
      await expect(transactionsMatching(input, refAccount.id)).resolves.toEqual(
        expected,
      );
    });
  });

  describe("words and splits (plan section 8)", () => {
    it.each<[string, string[], string[]]>([
      ["costco gas", ["P", "S"], ["P", "S/Gas"]],
      ['"costco gas"', ["P"], ["P"]],
      ["cat:groceries cat:gas", ["S"], []],
      ["costco -cat:gas", [], ["S/Groceries"]],
      ["amount:>90", ["S"], ["S/Gas", "S/Groceries"]],
      ["amount:=20", ["S"], ["S/Gas"]],
      ["is:split", ["S"], ["S/Gas", "S/Groceries"]],
      ['payee:="costco"', ["S"], ["S/Gas", "S/Groceries"]],
    ])("%j", async (input, transactionGrain, splitGrain) => {
      await expect(
        transactionsMatching(input, splitAccount.id),
      ).resolves.toEqual(transactionGrain);
      await expect(splitRowsMatching(input)).resolves.toEqual(splitGrain);
    });
  });

  it.each(["transaction", "t", "bf"])(
    "every field and operator is valid SQL under the alias %j",
    async (alias) => {
      // Each query stays within the 12-term cap and starts with a term that
      // matches nothing, so every arm is planned and executed on an empty
      // result.
      for (const query of [
        "nomatch payee:x memo:=x cat:x* tag:x account:x ref:=x #1",
        "nomatch status:void is:transfer is:uncategorized has:attachment has:memo has:tag has:ref",
      ]) {
        await expect(
          transactionsMatching(query, refAccount.id, alias),
        ).resolves.toEqual([]);
      }
      await expect(
        transactionsMatching(
          "amount:>1 amount:1..2 date:2026 date:>=2026-03-15 -is:split",
          refAccount.id,
          alias,
        ),
      ).resolves.toEqual([]);
    },
  );

  describe("INV-SEARCH-002: a single bare term matches what it matches today", () => {
    async function legacyMatching(
      term: string,
      accountId: string,
    ): Promise<string[]> {
      const parsed = parseSearchTerm(term, EN);
      const qb = transactionQuery("transaction", accountId)
        .leftJoin("transaction.splits", "splits")
        .distinct(true)
        .andWhere(
          buildTransactionSearchClause({
            transaction: "transaction",
            splits: "splits",
          }),
          {
            search: `%${escapeLikePattern(term.trim())}%`,
            searchAmount: parsed.amount,
            searchDate: parsed.date,
          },
        );
      const rows: Array<{ id: string }> = await qb.getRawMany();
      return rows.map((row) => labels.get(row.id) as string).sort();
    }

    it.each([
      "10",
      "0010",
      "100",
      "-10",
      "20",
      "80.00",
      "costco",
      "gas",
      "groceries",
      "invoice",
      "2026-03-15",
      "%",
      "_",
      "co_tco",
      "\\",
      "nothing-matches",
    ])("%j", async (term) => {
      for (const account of [refAccount, splitAccount]) {
        await expect(transactionsMatching(term, account.id)).resolves.toEqual(
          await legacyMatching(term, account.id),
        );
      }
    });
  });

  it("the reference key's SQL equals its TypeScript twin", async () => {
    const values = [
      "10",
      "0010",
      "#10",
      "#0010",
      " 10 ",
      "A10",
      "a010",
      "0",
      "000",
      "#",
      "##10",
      "Ab#1",
    ];
    const rows: Array<{ ref: string; key: string }> = await dataSource.query(
      `SELECT v.ref, ${referenceKeySql("v.ref")} AS key FROM unnest($1::text[]) AS v(ref)`,
      [values],
    );
    expect(rows.map((row) => [row.ref, row.key])).toEqual(
      values.map((value) => [value, referenceKey(value)]),
    );
  });
});
