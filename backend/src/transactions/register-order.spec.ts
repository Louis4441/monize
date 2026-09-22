import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SelectQueryBuilder } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import {
  applyRegisterOrder,
  creditsBeforeDebitsDirection,
  isTransactionSortField,
  registerPrimaryOrder,
  TRANSACTION_SORT_FIELDS,
  type RegisterSortAliases,
  type TransactionSortField,
} from "./register-order";

/**
 * The ordering itself, and the guard that stops a fifth copy of it appearing.
 *
 * The property under test is not "these four columns in this order" -- it is
 * that a credit and a debit the clock cannot separate come out chronologically
 * credit-first, whichever way the list runs. Asserting the column list alone
 * would pass for the inverted tiebreak, which is the mistake most available
 * here.
 */

type RecordedOrder = [string, string, string | undefined];

function recordingBuilder(): {
  builder: SelectQueryBuilder<Transaction>;
  calls: RecordedOrder[];
} {
  const calls: RecordedOrder[] = [];
  const builder = {
    orderBy: (column: string, direction: string, nulls?: string) => {
      calls.push([column, direction, nulls]);
      return builder;
    },
    addOrderBy: (column: string, direction: string, nulls?: string) => {
      calls.push([column, direction, nulls]);
      return builder;
    },
  } as unknown as SelectQueryBuilder<Transaction>;
  return { builder, calls };
}

function orderFor(
  direction: "ASC" | "DESC",
  field?: TransactionSortField,
  aliases?: RegisterSortAliases,
): RecordedOrder[] {
  const { builder, calls } = recordingBuilder();
  applyRegisterOrder(builder, "t", direction, field, aliases);
  return calls;
}

/** The order keys alone, for a case that is about the columns and not the nulls. */
function columnsFor(
  direction: "ASC" | "DESC",
  field?: TransactionSortField,
  aliases?: RegisterSortAliases,
): Array<[string, string]> {
  return orderFor(direction, field, aliases).map(([column, order]) => [
    column,
    order,
  ]);
}

/**
 * The register as the user reads it: rows in the order the query returns them,
 * with the running balance walked down from the newest, exactly as
 * `TransactionList` does it.
 */
function runningBalances(
  rows: ReadonlyArray<{ id: string; amount: number }>,
  startingBalance: number,
): Map<string, number> {
  const balances = new Map<string, number>();
  let cumulative = 0;
  for (const row of rows) {
    balances.set(row.id, startingBalance - cumulative);
    cumulative += row.amount;
  }
  return balances;
}

/** Sorts by the ordering under test, for rows that tie on date and createdAt. */
function sortByRegisterOrder<T extends { id: string; amount: number }>(
  rows: readonly T[],
  direction: "ASC" | "DESC",
): T[] {
  const amountDirection = creditsBeforeDebitsDirection(direction);
  return [...rows].sort((a, b) =>
    a.amount === b.amount
      ? a.id.localeCompare(b.id) * (direction === "DESC" ? -1 : 1)
      : (a.amount - b.amount) * (amountDirection === "ASC" ? 1 : -1),
  );
}

describe("applyRegisterOrder", () => {
  it("orders by date, then created_at, then amount, then id", () => {
    expect(columnsFor("DESC")).toEqual([
      ["t.transactionDate", "DESC"],
      ["t.createdAt", "DESC"],
      ["t.amount", "ASC"],
      ["t.id", "DESC"],
    ]);
  });

  it("runs the amount tiebreak opposite to the list, in both directions", () => {
    // The rule is chronological -- credits first -- so a newest-first list puts
    // them last. Hardcoding ASC would silently invert the ascending register.
    expect(creditsBeforeDebitsDirection("DESC")).toBe("ASC");
    expect(creditsBeforeDebitsDirection("ASC")).toBe("DESC");
    expect(columnsFor("ASC")).toEqual([
      ["t.transactionDate", "ASC"],
      ["t.createdAt", "ASC"],
      ["t.amount", "DESC"],
      ["t.id", "ASC"],
    ]);
  });

  it("makes the date the second key under any other field", () => {
    // Without this leg a payee's rows come out in the order they were
    // imported in, because `created_at` is the next key and a whole import
    // shares one value. The register is a ledger even when it is grouped.
    expect(columnsFor("DESC", "payee")).toEqual([
      ["t.payeeName", "DESC"],
      ["t.transactionDate", "DESC"],
      ["t.createdAt", "DESC"],
      ["t.amount", "ASC"],
      ["t.id", "DESC"],
    ]);
    // The date sort does not repeat itself as its own tiebreak.
    expect(
      columnsFor("DESC").filter(([c]) => c === "t.transactionDate"),
    ).toHaveLength(1);
  });

  it("keeps the tiebreaks below every field", () => {
    for (const field of TRANSACTION_SORT_FIELDS) {
      const tail = columnsFor("DESC", field, {
        account: "account",
        category: "category",
      }).slice(-3);
      expect(tail).toEqual([
        ["t.createdAt", "DESC"],
        ["t.amount", "ASC"],
        ["t.id", "DESC"],
      ]);
    }
  });

  it("sinks nulls in both directions, on the nullable fields only", () => {
    // A blank payee is the absence of a payee, not the smallest one:
    // reversing the sort must not fill the top of the register with rows that
    // have nothing in the column being sorted by.
    for (const direction of ["ASC", "DESC"] as const) {
      expect(orderFor(direction, "payee")[0][2]).toBe("NULLS LAST");
      expect(orderFor(direction, "description")[0][2]).toBe("NULLS LAST");
      expect(orderFor(direction, "refNumber")[0][2]).toBe("NULLS LAST");
      expect(
        orderFor(direction, "category", { category: "category" })[0][2],
      ).toBe("NULLS LAST");
      expect(orderFor(direction, "date")[0][2]).toBeUndefined();
      expect(orderFor(direction, "amount")[0][2]).toBeUndefined();
      expect(orderFor(direction, "status")[0][2]).toBeUndefined();
    }
  });

  it("orders a joined field by the alias it was given", () => {
    expect(columnsFor("ASC", "account", { account: "account" })[0]).toEqual([
      "account.name",
      "ASC",
    ]);
    expect(columnsFor("ASC", "category", { category: "category" })[0]).toEqual([
      "category.name",
      "ASC",
    ]);
  });

  it("refuses a joined field on a query that does not join the table", () => {
    // The three queries that sum the rows newer than a page select from
    // `transactions` alone. Emitting `account.name` there would be SQL naming
    // an alias the statement does not have -- a runtime error on a balance
    // query, found in production rather than here.
    expect(() => registerPrimaryOrder("account", "t")).toThrow(/join alias/i);
    expect(() => registerPrimaryOrder("category", "t")).toThrow(/join alias/i);
    expect(() => orderFor("DESC", "account")).toThrow(/join alias/i);
  });

  it("names a real column for every field it offers", () => {
    // A field added to the list with no case in `registerPrimaryOrder` would
    // return undefined and order by "undefined", which PostgreSQL rejects at
    // the far end of a user's click.
    for (const field of TRANSACTION_SORT_FIELDS) {
      const { expression } = registerPrimaryOrder(field, "t", {
        account: "account",
        category: "category",
      });
      expect(expression).toMatch(/^[a-z]+\.[A-Za-z]+$/);
    }
  });

  it("recognises exactly the fields it lists", () => {
    for (const field of TRANSACTION_SORT_FIELDS) {
      expect(isTransactionSortField(field)).toBe(true);
    }
    for (const value of ["tags", "balance", "DATE", "", null, 3, ["date"]]) {
      expect(isTransactionSortField(value)).toBe(false);
    }
  });
});

describe("the running balance a tied credit and debit produce", () => {
  // The reported case: an investment purchase funded by a transfer on the same
  // day. Both rows are written by one import, so `created_at` -- which defaults
  // to CURRENT_TIMESTAMP, one value per transaction -- cannot separate them,
  // and the order used to fall through to a random UUID.
  const TRANSFER_IN = { id: "aaaa-credit", amount: 2400 };
  const PURCHASE = { id: "bbbb-debit", amount: -2400 };
  const OPENING = 0;

  it.each([["DESC" as const], ["ASC" as const]])(
    "never dips below zero in a %s register",
    (direction) => {
      const rows = sortByRegisterOrder([PURCHASE, TRANSFER_IN], direction);
      // The running balance is only ever walked newest-first.
      const newestFirst = direction === "DESC" ? rows : [...rows].reverse();
      const balances = runningBalances(newestFirst, OPENING);

      expect(Math.min(...balances.values())).toBe(0);
      expect(balances.get(TRANSFER_IN.id)).toBe(2400);
      expect(balances.get(PURCHASE.id)).toBe(0);
    },
  );

  it("dips negative when the debit is treated as the older row", () => {
    // The defect, stated as a test: with the credit ordered second in a
    // newest-first list, the purchase reads as having happened first and the
    // account appears overdrawn on a day it was never short.
    const balances = runningBalances([TRANSFER_IN, PURCHASE], OPENING);

    expect(balances.get(PURCHASE.id)).toBe(-2400);
  });
});

describe("the register ordering is written once", () => {
  it("has no hand-rolled copy left in the transactions service", () => {
    // Three of the four sites sum the rows on *previous* pages so page N's
    // running balance starts from the right number. A tiebreak added to the
    // register alone re-splits the pages under those sums.
    //
    // Deliberately out of scope, and why the scan is written against
    // `addOrderBy` rather than against the column name: the payee-autofill
    // lookup orders by `{ transactionDate, createdAt }` in `find`'s object
    // form. It shows no balance and no page, so it has nothing to agree with.
    const source = readFileSync(
      join(__dirname, "transactions.service.ts"),
      "utf8",
    );

    const applications = source.match(/applyRegisterOrder\(/g) ?? [];
    expect(applications).toHaveLength(4);
    expect(source).not.toMatch(/addOrderBy\(\s*["'`][^"'`]*\.createdAt/);
  });
});
