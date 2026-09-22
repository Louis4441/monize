import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import {
  TRANSACTION_SORT_FIELDS,
  type TransactionSortField,
} from "@/transactions/register-order";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * The register's sort, against a real PostgreSQL.
 *
 * Two properties no mock can show. The first is the one the whole design
 * exists for: **a row's running balance is the same figure whichever way the
 * date register runs.** The seed is the balance after the page's newest row
 * and the client walks it newest-first, so reversing the register reverses
 * which rows are "newer than this page" -- the pages above become the pages
 * below -- and only a real query over real pages proves the two windows name
 * the same rows. A unit test with a mocked query builder asserts the SQL it
 * was handed, which is the thing under suspicion.
 *
 * The second is that **every sortable column can actually be paged by.**
 * TypeORM pages a query with joins by selecting DISTINCT ids plus the order
 * columns from a subquery; an order key that does not resolve there throws,
 * and one on a one-to-many join silently repeats rows across pages. Both are
 * invisible until a real database runs the statement.
 */

const OPENING_BALANCE = 1000;
const CENTS = 10000;

/** Integer arithmetic, as the client does it: never accumulate floats. */
const toCents = (value: number | string) => Math.round(Number(value) * CENTS);

/** A VOID row records something that did not happen; a split child is not a movement. */
const movesBalance = (row: Transaction) =>
  row.status !== TransactionStatus.VOID && !row.parentTransactionId;

/**
 * What the row contributes, which is the visible split total when a filter
 * returned only some of a split's lines -- the same rule the register draws
 * the Amount column with.
 */
function rowAmountCents(row: Transaction): number {
  const splits = (row as Transaction & { splits?: { amount: number }[] })
    .splits;
  if (row.isSplit && splits && splits.length > 0) {
    const sum = splits.reduce((total, s) => total + toCents(s.amount), 0);
    if (sum !== toCents(row.amount)) return sum;
  }
  return toCents(row.amount);
}

describe("register sorting (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;
  let otherAccountId: string;
  let alphaCategoryId: string;
  let zuluCategoryId: string;

  type ListOptions = {
    accountIds?: string[];
    startDate?: string;
    endDate?: string;
    categoryIds?: string[];
    payeeIds?: string[];
    page?: number;
    limit?: number;
    targetTransactionId?: string;
    sortBy?: TransactionSortField;
    sortDirection?: "ASC" | "DESC";
  };

  const list = (options: ListOptions) =>
    withUserContext(userId, () =>
      service.findAll(
        userId,
        options.accountIds,
        options.startDate,
        options.endDate,
        options.categoryIds,
        options.payeeIds,
        options.page ?? 1,
        options.limit ?? 50,
        false,
        undefined,
        options.targetTransactionId,
        undefined,
        undefined,
        undefined,
        undefined,
        options.sortBy ?? "date",
        options.sortDirection ?? "DESC",
      ),
    );

  /** Every page of a listing, in order. */
  async function allPages(options: ListOptions) {
    const limit = options.limit ?? 3;
    const first = await list({ ...options, page: 1, limit });
    const pages = [first];
    for (let page = 2; page <= first.pagination.totalPages; page++) {
      pages.push(await list({ ...options, page, limit }));
    }
    return pages;
  }

  /**
   * The balance the register prints beside every row, over every page: each
   * page seeded with its own `startingBalance` and walked newest-first, which
   * means reversing an oldest-first page before walking it.
   */
  async function balancesByRow(
    options: ListOptions,
  ): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    for (const page of await allPages(options)) {
      expect(page.startingBalance).toBeDefined();
      const seedCents = toCents(page.startingBalance!);
      const newestFirst =
        (options.sortDirection ?? "DESC") === "ASC"
          ? [...page.data].reverse()
          : page.data;
      let cumulative = 0;
      for (const row of newestFirst) {
        balances.set(row.id, (seedCents - cumulative) / CENTS);
        if (movesBalance(row as Transaction)) {
          cumulative += rowAmountCents(row as Transaction);
        }
      }
    }
    return balances;
  }

  /** The listing's rows in the order the register returns them, over every page. */
  async function rowsInOrder(options: ListOptions) {
    const pages = await allPages(options);
    return {
      rows: pages.flatMap((page) => page.data),
      total: pages[0].pagination.total,
      pageIds: pages.map((page) => page.data.map((row) => row.id)),
    };
  }

  /**
   * The same listing both ways round: the ids it holds, and the balance beside
   * each one. This is the assertion the design turns on.
   */
  async function expectBalanceParity(options: ListOptions) {
    const descending = await balancesByRow({
      ...options,
      sortDirection: "DESC",
    });
    const ascending = await balancesByRow({ ...options, sortDirection: "ASC" });

    expect([...ascending.keys()].sort()).toEqual([...descending.keys()].sort());
    expect(descending.size).toBeGreaterThan(0);
    for (const [id, balance] of descending) {
      expect({ id, balance: ascending.get(id) }).toEqual({ id, balance });
    }
    return descending;
  }

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    // "AA" and "ZZ" so an account sort has something to order.
    const account = await createTestAccount(dataSource, userId, {
      name: "AA Chequing",
      openingBalance: OPENING_BALANCE,
      currentBalance: OPENING_BALANCE,
    });
    accountId = account.id;
    const other = await createTestAccount(dataSource, userId, {
      name: "ZZ Savings",
      openingBalance: 0,
      currentBalance: 0,
    });
    otherAccountId = other.id;

    const alpha = await createTestCategory(dataSource, userId, {
      name: "Alpha",
    });
    alphaCategoryId = alpha.id;
    const zulu = await createTestCategory(dataSource, userId, { name: "Zulu" });
    zuluCategoryId = zulu.id;

    // A ledger with every row shape that has ever made a running balance wrong:
    // a VOID row that occupies a line but moves nothing, a split parent whose
    // lines a filter can match in part, a future-dated row the projected
    // balance still counts, and rows with nothing in the columns being sorted
    // by. Written through the service so the rows are the ones it would create.
    await withUserContext(userId, async () => {
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-01",
        amount: -10,
        currencyCode: "USD",
        payeeName: "Anna",
        categoryId: alphaCategoryId,
        description: "aaa",
        referenceNumber: "001",
      } as never);
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-02",
        amount: -20,
        currencyCode: "USD",
        payeeName: "Bob",
        categoryId: zuluCategoryId,
      } as never);
      // Nothing in payee, category, description or reference: the row that
      // proves nulls sink rather than ride the sort.
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-03",
        amount: -30,
        currencyCode: "USD",
      } as never);
      const voided = await service.create(userId, {
        accountId,
        transactionDate: "2026-01-04",
        amount: 40,
        currencyCode: "USD",
        payeeName: "Dave",
      } as never);
      await service.updateStatus(userId, voided.id, TransactionStatus.VOID);
      await service.create(userId, {
        accountId,
        transactionDate: "2026-01-05",
        amount: -100,
        currencyCode: "USD",
        payeeName: "Eve",
        isSplit: true,
        splits: [
          { categoryId: alphaCategoryId, amount: -60 },
          { categoryId: zuluCategoryId, amount: -40 },
        ],
      } as never);
      await service.create(userId, {
        accountId,
        transactionDate: "2027-01-01",
        amount: -5,
        currencyCode: "USD",
        payeeName: "Zoe",
        description: "future",
      } as never);
      await service.create(userId, {
        accountId: otherAccountId,
        transactionDate: "2026-01-06",
        amount: -70,
        currencyCode: "USD",
        payeeName: "Anna",
        categoryId: alphaCategoryId,
      } as never);
    });

    // The pair the clock cannot separate: one save, so PostgreSQL's
    // CURRENT_TIMESTAMP (transaction start time) gives both rows the same
    // created_at, which is what an import does. Credits order before debits
    // chronologically, so neither direction may show the account overdrawn.
    await dataSource.manager.save(Transaction, [
      dataSource.manager.create(Transaction, {
        userId,
        accountId,
        transactionDate: "2026-02-01",
        amount: 2400,
        currencyCode: "USD",
        payeeName: "Transfer in",
        status: TransactionStatus.UNRECONCILED,
      } as never),
      dataSource.manager.create(Transaction, {
        userId,
        accountId,
        transactionDate: "2026-02-01",
        amount: -2400,
        currencyCode: "USD",
        payeeName: "Purchase",
        status: TransactionStatus.UNRECONCILED,
      } as never),
    ]);
  });

  describe("a row's balance is the same figure whichever way the register runs", () => {
    it("holds across page boundaries on an unfiltered account", async () => {
      const balances = await expectBalanceParity({
        accountIds: [accountId],
        limit: 3,
      });

      // And the ledger it walks is the real one: the oldest row's balance is
      // the opening balance plus that row. An off-by-one window would leave
      // every figure plausible and every figure wrong.
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        limit: 3,
        sortDirection: "ASC",
      });
      const oldest = rows[0] as Transaction;
      const expected =
        (toCents(OPENING_BALANCE) +
          (movesBalance(oldest) ? rowAmountCents(oldest) : 0)) /
        CENTS;
      expect(balances.get(oldest.id)).toBe(expected);
    });

    it("never shows the account overdrawn on the day a transfer funded it", async () => {
      // Both rows share a created_at, so only the amount tiebreak separates
      // them -- and it has to run opposite to the list for the credit to stay
      // chronologically first in both directions.
      const balances = await expectBalanceParity({
        accountIds: [accountId],
        limit: 2,
      });
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        limit: 50,
      });
      const pair = (rows as Transaction[]).filter(
        (row) => row.transactionDate === "2026-02-01",
      );
      expect(pair).toHaveLength(2);
      const credit = pair.find((row) => Number(row.amount) > 0)!;
      const debit = pair.find((row) => Number(row.amount) < 0)!;
      expect(balances.get(credit.id)! - 2400).toBe(balances.get(debit.id));
    });

    it("holds under a date filter", async () => {
      await expectBalanceParity({
        accountIds: [accountId],
        endDate: "2026-01-31",
        limit: 2,
      });
    });

    it("holds under a content filter, where the balance is zero-based", async () => {
      const balances = await expectBalanceParity({
        accountIds: [accountId],
        categoryIds: [zuluCategoryId],
        limit: 2,
      });
      // A zero-based balance starts from the matched total, so the newest
      // matching row carries it.
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        categoryIds: [zuluCategoryId],
        limit: 50,
      });
      const matchedTotal =
        (rows as Transaction[]).reduce(
          (total, row) => total + (movesBalance(row) ? rowAmountCents(row) : 0),
          0,
        ) / CENTS;
      expect(balances.get((rows[0] as Transaction).id)).toBe(matchedTotal);
    });

    it("holds across two accounts whose split lines a category filter matches in part", async () => {
      // The split parent is -100 with one -60 line in Alpha: the page shows
      // the partial total and the window must sum the same partial total, or
      // the two directions disagree by 40.
      await expectBalanceParity({
        accountIds: [accountId, otherAccountId],
        categoryIds: [alphaCategoryId],
        limit: 2,
      });
    });
  });

  describe("every sortable column can be paged by", () => {
    it.each(TRANSACTION_SORT_FIELDS)(
      "pages %s without losing, repeating or reordering a row",
      async (field) => {
        for (const sortDirection of ["ASC", "DESC"] as const) {
          const { rows, total, pageIds } = await rowsInOrder({
            accountIds: [accountId, otherAccountId],
            sortBy: field,
            sortDirection,
            limit: 2,
          });
          const ids = pageIds.flat();
          // Disjoint pages covering the whole listing: a one-to-many order key
          // would repeat rows here, and an order column missing from the
          // DISTINCT subquery would drop them.
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBe(total);
          expect(rows.length).toBe(total);
        }
      },
    );

    it("sinks the rows with nothing in the sorted column, in both directions", async () => {
      for (const field of [
        "payee",
        "category",
        "description",
        "refNumber",
      ] as const) {
        for (const sortDirection of ["ASC", "DESC"] as const) {
          const { rows } = await rowsInOrder({
            accountIds: [accountId],
            sortBy: field,
            sortDirection,
            limit: 50,
          });
          const isBlank = (row: Transaction) => {
            if (field === "payee") return row.payeeName == null;
            if (field === "category") return row.categoryId == null;
            if (field === "description") return row.description == null;
            return row.referenceNumber == null;
          };
          const blankPositions = (rows as Transaction[])
            .map((row, index) => (isBlank(row) ? index : -1))
            .filter((index) => index >= 0);
          const firstBlank = Math.min(...blankPositions);
          expect(blankPositions.length).toBeGreaterThan(0);
          // Every blank sits after every non-blank: reversing the sort must
          // not fill the top of the register with rows that say nothing about
          // the column being sorted by.
          expect(firstBlank).toBe(rows.length - blankPositions.length);
        }
      }
    });

    it("reads chronologically within one payee", async () => {
      // Without the date as the second key these come out in insertion order,
      // because a whole import shares one created_at.
      const { rows } = await rowsInOrder({
        accountIds: [accountId, otherAccountId],
        sortBy: "payee",
        sortDirection: "ASC",
        limit: 50,
      });
      const anna = (rows as Transaction[]).filter(
        (row) => row.payeeName === "Anna",
      );
      expect(anna).toHaveLength(2);
      expect(anna[0].transactionDate < anna[1].transactionDate).toBe(true);
    });
  });

  describe("the balance under a sort other than date", () => {
    it("is withheld, and the response says why", async () => {
      const result = await list({
        accountIds: [accountId],
        sortBy: "amount",
        sortDirection: "DESC",
      });
      expect(result.startingBalance).toBeUndefined();
      expect(result.startingBalanceWithheld).toBe("sort");
    });

    it("says nothing where the register never had a balance", async () => {
      const result = await list({ sortBy: "payee", sortDirection: "ASC" });
      expect(result.startingBalance).toBeUndefined();
      expect(result.startingBalanceWithheld).toBeUndefined();
    });

    it("comes back the moment the register is date-ordered again", async () => {
      const result = await list({
        accountIds: [accountId],
        sortBy: "date",
        sortDirection: "ASC",
      });
      expect(result.startingBalance).toBeDefined();
      expect(result.startingBalanceWithheld).toBeUndefined();
    });
  });

  describe("a deep-linked row", () => {
    it("is found on mirrored pages in the two directions", async () => {
      const { rows, total } = await rowsInOrder({
        accountIds: [accountId],
        limit: 50,
      });
      const target = rows[3] as Transaction;
      const limit = 2;

      const descending = await list({
        accountIds: [accountId],
        limit,
        targetTransactionId: target.id,
      });
      const ascending = await list({
        accountIds: [accountId],
        limit,
        sortDirection: "ASC",
        targetTransactionId: target.id,
      });

      expect(descending.data.some((row) => row.id === target.id)).toBe(true);
      expect(ascending.data.some((row) => row.id === target.id)).toBe(true);
      // The page holding a row counting from one end is its mirror counting
      // from the other.
      const lastPage = Math.ceil(total / limit);
      expect(ascending.pagination.page).toBe(
        lastPage + 1 - descending.pagination.page,
      );
    });

    it("is refused under a sort that cannot place it", async () => {
      const { rows } = await rowsInOrder({
        accountIds: [accountId],
        limit: 50,
      });
      await expect(
        list({
          accountIds: [accountId],
          sortBy: "payee",
          targetTransactionId: (rows[0] as Transaction).id,
        }),
      ).rejects.toThrow();
    });
  });
});
