import { Global, Module, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import {
  createTestUser,
  createTestAccount,
  createTestCategory,
  createTestPayee,
  buildTransaction,
} from "./helpers/test-factories";
import { CategoriesModule } from "@/categories/categories.module";
import { CategoryDetailService } from "@/categories/category-detail.service";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { User } from "@/users/entities/user.entity";
import { withUserContext } from "@/common/db/with-context";

/**
 * CategoriesService injects I18nService for localized errors and default
 * category names. The app supplies it via the global nestjs-i18n module; this
 * suite builds CategoriesModule in isolation, so a stub stands in -- the real
 * I18nModule's `watch: true` file watcher would leak a handle and hang Jest.
 * The stub returns the English `defaultValue`, matching production behaviour
 * for the default locale.
 */
@Global()
@Module({
  providers: [
    {
      provide: I18nService,
      useValue: {
        translate: (key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? key,
        t: (key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? key,
      },
    },
  ],
  exports: [I18nService],
})
class TestI18nModule {}

/**
 * The category detail aggregate against a real database. The unit spec mocks
 * the query builders, so it proves the mapping but not the SQL -- these tests
 * are what catch a wrong column name, a GROUP BY Postgres rejects, a numeric
 * that arrives as a string, or a split join that double-counts a parent.
 */
describe("CategoryDetailService (e2e)", () => {
  let testModule: TestingModule;
  let ds: DataSource;
  let service: CategoryDetailService;
  let userId: string;
  let otherUserId: string;
  let accountId: string;
  let secondAccountId: string;

  beforeAll(async () => {
    // Only the module and its DataSource are needed -- this suite calls the
    // service directly rather than over HTTP, so it deliberately skips
    // `createTestApp` and the Nest HTTP layer it builds.
    testModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TestI18nModule,
        TypeOrmModule.forRoot({
          type: "postgres",
          host: process.env.DATABASE_HOST || "localhost",
          port: parseInt(process.env.DATABASE_PORT || "5432"),
          username: process.env.DATABASE_USER || "monize_test",
          password: process.env.DATABASE_PASSWORD || "test_password",
          database: process.env.DATABASE_NAME || "monize_test",
          entities: [__dirname + "/../src/**/*.entity{.ts,.js}"],
          synchronize: true,
          dropSchema: true,
        }),
        CategoriesModule,
      ],
    }).compile();
    await testModule.init();

    ds = testModule.get(DataSource);
    service = testModule.get(CategoryDetailService);

    const user = await createTestUser(ds.getRepository(User));
    userId = user.id;
    const other = await createTestUser(ds.getRepository(User), {
      email: `other-${Date.now()}@example.com`,
    });
    otherUserId = other.id;

    accountId = (await createTestAccount(ds, userId, { name: "Chequing" })).id;
    secondAccountId = (await createTestAccount(ds, userId, { name: "Visa" }))
      .id;
  });

  afterAll(async () => {
    await testModule?.close();
  });

  /** Insert one transaction, bypassing service logic. */
  async function addTransaction(overrides: Record<string, unknown> = {}) {
    const entity = ds.manager.create(Transaction, {
      ...buildTransaction(userId, accountId),
      ...overrides,
    } as never);
    return ds.manager.save(entity) as Promise<Transaction>;
  }

  /** Insert one split line for a transaction, bypassing service logic. */
  async function addSplit(
    transactionId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const entity = ds.manager.create(TransactionSplit, {
      transactionId,
      kind: SplitKind.CATEGORY,
      amount: -10,
      ...overrides,
    } as never);
    return ds.manager.save(entity);
  }

  function getDetail(categoryId: string, asUserId = userId) {
    // No HTTP request here, so the identity context withScopedDb requires has
    // to be established explicitly.
    return withUserContext(asUserId, () =>
      service.getDetail(asUserId, categoryId),
    );
  }

  it("aggregates lifetime stats over the whole subtree, grandchildren included", async () => {
    const root = await createTestCategory(ds, userId, {
      name: `Home ${Date.now()}`,
    });
    const child = await createTestCategory(ds, userId, {
      name: `Repairs ${Date.now()}`,
      parentId: root.id,
    });
    const grandchild = await createTestCategory(ds, userId, {
      name: `Plumbing ${Date.now()}`,
      parentId: child.id,
    });
    await addTransaction({
      categoryId: root.id,
      transactionDate: "2024-03-01",
      amount: -20,
    });
    await addTransaction({
      categoryId: child.id,
      transactionDate: "2025-06-15",
      amount: -30,
    });
    await addTransaction({
      categoryId: grandchild.id,
      transactionDate: "2026-01-10",
      amount: -12.5,
    });

    const detail = await getDetail(root.id);

    expect(detail.category.id).toBe(root.id);
    expect(detail.stats.transactionCount).toBe(3);
    expect(detail.stats.firstTransactionDate).toBe("2024-03-01");
    expect(detail.stats.lastTransactionDate).toBe("2026-01-10");
    expect(detail.stats.subcategoryCount).toBe(1);
  });

  it("counts a transaction once when it matches through split lines, summing only the matching splits", async () => {
    const category = await createTestCategory(ds, userId, {
      name: `SplitTarget ${Date.now()}`,
    });
    const elsewhere = await createTestCategory(ds, userId, {
      name: `Elsewhere ${Date.now()}`,
    });
    // A split parent categorized nowhere itself: two of its three lines land
    // in the category, the third goes elsewhere. The transaction counts once
    // and only the matching lines' money counts.
    const parent = await addTransaction({
      categoryId: null,
      isSplit: true,
      amount: -100,
      transactionDate: "2026-02-01",
    });
    await addSplit(parent.id, { categoryId: category.id, amount: -55 });
    await addSplit(parent.id, { categoryId: category.id, amount: -25 });
    await addSplit(parent.id, { categoryId: elsewhere.id, amount: -20 });

    const detail = await getDetail(category.id);

    expect(detail.stats.transactionCount).toBe(1);
    expect(detail.accounts).toHaveLength(1);
    expect(detail.accounts[0].transactionCount).toBe(1);
    expect(detail.accounts[0].total).toBeCloseTo(-80, 4);
  });

  it("excludes void transactions, split children and transfer splits", async () => {
    const category = await createTestCategory(ds, userId, {
      name: `Scope ${Date.now()}`,
    });
    const parent = await addTransaction({
      categoryId: category.id,
      amount: -100,
      isSplit: true,
    });
    await addTransaction({
      categoryId: category.id,
      amount: -60,
      parentTransactionId: parent.id,
    });
    await addTransaction({
      categoryId: category.id,
      amount: -999,
      status: "VOID",
    });
    // A transfer split is money moved between own accounts, not spending --
    // even a categorized one stays out, matching the analytics summary.
    const transferParent = await addTransaction({
      categoryId: null,
      isSplit: true,
      amount: -40,
    });
    await addSplit(transferParent.id, {
      categoryId: category.id,
      amount: -40,
      kind: SplitKind.TRANSFER,
      transferAccountId: secondAccountId,
    });

    const detail = await getDetail(category.id);

    // Only the split parent counts: the child would double-count it, the void
    // row never happened, and the transfer split moved money, not spending.
    expect(detail.stats.transactionCount).toBe(1);
    expect(detail.accounts[0].total).toBeCloseTo(-100, 4);
  });

  it("breaks the history down per account, in that account's currency", async () => {
    const category = await createTestCategory(ds, userId, {
      name: `Accounts ${Date.now()}`,
    });
    await addTransaction({ categoryId: category.id, amount: -10 });
    await addTransaction({ categoryId: category.id, amount: -15 });
    await addTransaction({
      categoryId: category.id,
      accountId: secondAccountId,
      amount: -7.25,
      transactionDate: "2026-02-02",
    });

    const detail = await getDetail(category.id);

    expect(detail.accounts).toHaveLength(2);
    // Ordered by transaction count, so the chequing account leads.
    const [first, second] = detail.accounts;
    expect(first.accountName).toBe("Chequing");
    expect(first.transactionCount).toBe(2);
    expect(first.total).toBeCloseTo(-25, 4);
    expect(typeof first.total).toBe("number");
    expect(second.accountName).toBe("Visa");
    expect(second.transactionCount).toBe(1);
    expect(second.total).toBeCloseTo(-7.25, 4);
    expect(second.lastTransactionDate).toBe("2026-02-02");
  });

  it("finds the largest contribution by absolute amount, using the split's own amount", async () => {
    const category = await createTestCategory(ds, userId, {
      name: `Largest ${Date.now()}`,
    });
    const payee = await createTestPayee(ds, userId, {
      name: `Big Box ${Date.now()}`,
    });
    await addTransaction({ categoryId: category.id, amount: -40 });
    await addTransaction({
      categoryId: category.id,
      amount: -412.5,
      transactionDate: "2025-12-24",
      payeeId: payee.id,
    });
    // A split parent with a huge total but a small line in this category must
    // not win on the parent's amount.
    const parent = await addTransaction({
      categoryId: null,
      isSplit: true,
      amount: -5000,
    });
    await addSplit(parent.id, { categoryId: category.id, amount: -30 });

    const detail = await getDetail(category.id);

    expect(detail.largestTransaction).not.toBeNull();
    expect(detail.largestTransaction!.amount).toBeCloseTo(-412.5, 4);
    expect(detail.largestTransaction!.transactionDate).toBe("2025-12-24");
    expect(detail.largestTransaction!.accountName).toBe("Chequing");
    expect(detail.largestTransaction!.payeeName).toBe(payee.name);
  });

  it("counts distinct payees across the subtree", async () => {
    const root = await createTestCategory(ds, userId, {
      name: `Payees ${Date.now()}`,
    });
    const child = await createTestCategory(ds, userId, {
      name: `PayeesChild ${Date.now()}`,
      parentId: root.id,
    });
    const payeeA = await createTestPayee(ds, userId, {
      name: `A ${Date.now()}`,
    });
    const payeeB = await createTestPayee(ds, userId, {
      name: `B ${Date.now()}`,
    });
    await addTransaction({ categoryId: root.id, payeeId: payeeA.id });
    await addTransaction({ categoryId: root.id, payeeId: payeeA.id });
    await addTransaction({ categoryId: child.id, payeeId: payeeB.id });
    await addTransaction({ categoryId: root.id, payeeId: null });

    const detail = await getDetail(root.id);

    expect(detail.stats.payeeCount).toBe(2);
  });

  it("lists payees defaulting to exactly this category, not the subtree", async () => {
    const root = await createTestCategory(ds, userId, {
      name: `Default ${Date.now()}`,
    });
    const child = await createTestCategory(ds, userId, {
      name: `DefaultChild ${Date.now()}`,
      parentId: root.id,
    });
    const direct = await createTestPayee(ds, userId, {
      name: `Direct ${Date.now()}`,
      defaultCategoryId: root.id,
    });
    await createTestPayee(ds, userId, {
      name: `ViaChild ${Date.now()}`,
      defaultCategoryId: child.id,
    });

    const detail = await getDetail(root.id);

    expect(detail.defaultCategoryForPayees).toEqual([
      { payeeId: direct.id, payeeName: direct.name },
    ]);
  });

  it("reports a never-used category as zeros and nulls", async () => {
    const category = await createTestCategory(ds, userId, {
      name: `Fresh ${Date.now()}`,
    });

    const detail = await getDetail(category.id);

    expect(detail.stats.transactionCount).toBe(0);
    expect(detail.stats.firstTransactionDate).toBeNull();
    expect(detail.stats.lastTransactionDate).toBeNull();
    expect(detail.stats.payeeCount).toBe(0);
    expect(detail.stats.subcategoryCount).toBe(0);
    expect(detail.accounts).toEqual([]);
    expect(detail.largestTransaction).toBeNull();
    expect(detail.defaultCategoryForPayees).toEqual([]);
  });

  it("refuses a category belonging to another user", async () => {
    const theirs = await withUserContext(otherUserId, () =>
      createTestCategory(ds, otherUserId, { name: `Theirs ${Date.now()}` }),
    );

    await expect(getDetail(theirs.id)).rejects.toThrow(NotFoundException);
  });
});
