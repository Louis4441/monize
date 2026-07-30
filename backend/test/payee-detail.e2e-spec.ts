import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  createTestUser,
  createTestAccount,
  createTestCategory,
  createTestPayee,
  buildTransaction,
} from "./helpers/test-factories";
import { PayeesModule } from "@/payees/payees.module";
import { PayeeDetailService } from "@/payees/payee-detail.service";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { PayeeAlias } from "@/payees/entities/payee-alias.entity";
import { Account } from "@/accounts/entities/account.entity";
import { User } from "@/users/entities/user.entity";
import { withUserContext } from "@/common/db/with-context";

/**
 * The payee detail aggregate against a real database. The unit spec mocks the
 * query builders, so it proves the mapping but not the SQL -- these tests are
 * what catch a wrong column name, a GROUP BY Postgres rejects, or a numeric
 * that arrives as a string.
 */
describe("PayeeDetailService (e2e)", () => {
  let testModule: TestingModule;
  let ds: DataSource;
  let service: PayeeDetailService;
  let userId: string;
  let otherUserId: string;
  let accountId: string;
  let secondAccountId: string;
  let categoryId: string;

  beforeAll(async () => {
    // Only the module and its DataSource are needed -- this suite calls the
    // service directly rather than over HTTP, so it deliberately skips
    // `createTestApp` and the Nest HTTP layer it builds.
    testModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
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
        PayeesModule,
      ],
    }).compile();
    await testModule.init();

    ds = testModule.get(DataSource);
    service = testModule.get(PayeeDetailService);

    const user = await createTestUser(ds.getRepository(User));
    userId = user.id;
    const other = await createTestUser(ds.getRepository(User), {
      email: `other-${Date.now()}@example.com`,
    });
    otherUserId = other.id;

    accountId = (await createTestAccount(ds, userId, { name: "Chequing" })).id;
    secondAccountId = (await createTestAccount(ds, userId, { name: "Visa" }))
      .id;
    categoryId = (await createTestCategory(ds, userId, { name: "Coffee" })).id;
  });

  afterAll(async () => {
    await testModule?.close();
  });

  /** Insert one transaction for a payee, bypassing service logic. */
  async function addTransaction(
    payeeId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const entity = ds.manager.create(Transaction, {
      ...buildTransaction(userId, accountId),
      payeeId,
      ...overrides,
    } as never);
    return ds.manager.save(entity);
  }

  function getDetail(payeeId: string) {
    // No HTTP request here, so the identity context withScopedDb requires has
    // to be established explicitly.
    return withUserContext(userId, () => service.getDetail(userId, payeeId));
  }

  it("aggregates lifetime stats over real rows", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Stats ${Date.now()}`,
    });
    await addTransaction(payee.id, {
      transactionDate: "2024-03-01",
      amount: -20,
      categoryId,
    });
    await addTransaction(payee.id, {
      transactionDate: "2025-06-15",
      amount: -30,
    });
    await addTransaction(payee.id, {
      transactionDate: "2026-01-10",
      amount: -12.5,
    });

    const detail = await getDetail(payee.id);

    expect(detail.payee.id).toBe(payee.id);
    expect(detail.stats.transactionCount).toBe(3);
    expect(detail.stats.firstTransactionDate).toBe("2024-03-01");
    expect(detail.stats.lastTransactionDate).toBe("2026-01-10");
  });

  it("excludes void transactions and split children from the counts", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Scope ${Date.now()}`,
    });
    const parent = await addTransaction(payee.id, {
      amount: -100,
      isSplit: true,
    });
    await addTransaction(payee.id, {
      amount: -60,
      parentTransactionId: (parent as unknown as { id: string }).id,
    });
    await addTransaction(payee.id, { amount: -999, status: "VOID" });

    const detail = await getDetail(payee.id);

    // Only the split parent counts: the child would double-count it, and the
    // void row never happened.
    expect(detail.stats.transactionCount).toBe(1);
  });

  it("breaks the history down per account, in that account's currency", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Accounts ${Date.now()}`,
    });
    await addTransaction(payee.id, { amount: -10 });
    await addTransaction(payee.id, { amount: -15 });
    await addTransaction(payee.id, {
      accountId: secondAccountId,
      amount: -7.25,
      transactionDate: "2026-02-02",
    });

    const detail = await getDetail(payee.id);

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

  it("finds the largest transaction by absolute amount", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Largest ${Date.now()}`,
    });
    await addTransaction(payee.id, { amount: -40 });
    await addTransaction(payee.id, {
      amount: -412.5,
      transactionDate: "2025-12-24",
    });
    await addTransaction(payee.id, { amount: 90 });

    const detail = await getDetail(payee.id);

    expect(detail.largestTransaction).not.toBeNull();
    expect(detail.largestTransaction!.amount).toBeCloseTo(-412.5, 4);
    expect(detail.largestTransaction!.transactionDate).toBe("2025-12-24");
    expect(detail.largestTransaction!.accountName).toBe("Chequing");
  });

  it("counts only the transactions a default-category backfill would touch", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Uncat ${Date.now()}`,
      defaultCategoryId: categoryId,
    });
    await addTransaction(payee.id, { categoryId: null });
    await addTransaction(payee.id, { categoryId: null });
    await addTransaction(payee.id, { categoryId });
    // A transfer is categorised implicitly, so a backfill skips it.
    await addTransaction(payee.id, { categoryId: null, isTransfer: true });

    const detail = await getDetail(payee.id);

    expect(detail.stats.uncategorizedCount).toBe(2);
  });

  it("counts the payee's aliases", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Aliased ${Date.now()}`,
    });
    await ds.manager.save(
      ds.manager.create(PayeeAlias, {
        payeeId: payee.id,
        userId,
        alias: `ALIAS-A-${Date.now()}`,
      } as never),
    );
    await ds.manager.save(
      ds.manager.create(PayeeAlias, {
        payeeId: payee.id,
        userId,
        alias: `ALIAS-B-${Date.now()}`,
      } as never),
    );

    const detail = await getDetail(payee.id);

    expect(detail.stats.aliasCount).toBe(2);
  });

  it("lists the loan accounts that designate the payee for overpayments", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Overpay ${Date.now()}`,
    });
    const loan = await createTestAccount(ds, userId, { name: "Mortgage" });
    await ds.manager.update(Account, loan.id, { overpaymentPayeeId: payee.id });

    const detail = await getDetail(payee.id);

    expect(detail.overpaymentForAccounts).toEqual([
      { accountId: loan.id, accountName: "Mortgage" },
    ]);
  });

  it("reports a never-transacted payee as zeros and nulls", async () => {
    const payee = await createTestPayee(ds, userId, {
      name: `Fresh ${Date.now()}`,
    });

    const detail = await getDetail(payee.id);

    expect(detail.stats.transactionCount).toBe(0);
    expect(detail.stats.firstTransactionDate).toBeNull();
    expect(detail.stats.lastTransactionDate).toBeNull();
    expect(detail.stats.uncategorizedCount).toBe(0);
    expect(detail.accounts).toEqual([]);
    expect(detail.largestTransaction).toBeNull();
    expect(detail.overpaymentForAccounts).toEqual([]);
  });

  it("refuses a payee belonging to another user", async () => {
    const theirs = await createTestPayee(ds, otherUserId, {
      name: `Theirs ${Date.now()}`,
    });

    await expect(getDetail(theirs.id)).rejects.toThrow(NotFoundException);
  });
});
