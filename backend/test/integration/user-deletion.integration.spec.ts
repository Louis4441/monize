import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { User } from "@/users/entities/user.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { Category } from "@/categories/entities/category.entity";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

// Regression: deleting a user used to fail with
//   update or delete on table "categories" violates foreign key constraint
//   "transaction_splits_category_id_fkey"
// because the category_id FKs on transactions / transaction_splits /
// scheduled_transactions / scheduled_transaction_splits were ON DELETE
// NO ACTION instead of SET NULL like every other category reference.
describe("User deletion category-FK cascade (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
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
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
  });

  async function seedUserWithCategorizedSplits(): Promise<{ userId: string }> {
    const user = await createTestUserDirect(dataSource);
    const account = await createTestAccount(dataSource, user.id, {
      openingBalance: 1000,
      currentBalance: 1000,
    });
    const category = await createTestCategory(dataSource, user.id);

    const txn = await dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId: user.id,
        accountId: account.id,
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        isSplit: true,
      }),
    );
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: txn.id,
        kind: SplitKind.CATEGORY,
        categoryId: category.id,
        amount: -50,
      }),
    );

    const scheduled = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId: user.id,
        accountId: account.id,
        name: "Recurring",
        categoryId: category.id,
        amount: -25,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: "2026-02-01",
        startDate: "2026-01-01",
      }),
    );
    await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduled.id,
        kind: SplitKind.CATEGORY,
        categoryId: category.id,
        amount: -25,
      }),
    );

    return { userId: user.id };
  }

  it("deletes a user that has category-referencing splits without an FK violation", async () => {
    const { userId } = await seedUserWithCategorizedSplits();
    const user = await dataSource.manager.findOneByOrFail(User, {
      id: userId,
    });

    await expect(
      dataSource.getRepository(User).remove(user),
    ).resolves.toBeDefined();

    // Cascades from users(id) removed everything user-owned.
    await expect(
      dataSource.manager.count(Category, { where: { userId } }),
    ).resolves.toBe(0);
    await expect(
      dataSource.manager.count(Transaction, { where: { userId } }),
    ).resolves.toBe(0);
    await expect(dataSource.manager.count(TransactionSplit)).resolves.toBe(0);
    await expect(
      dataSource.manager.count(ScheduledTransactionSplit),
    ).resolves.toBe(0);
  });

  it("nulls category_id on referencing rows when a category is deleted directly", async () => {
    const user = await createTestUserDirect(dataSource);
    const account = await createTestAccount(dataSource, user.id, {
      openingBalance: 1000,
      currentBalance: 1000,
    });
    const category = await createTestCategory(dataSource, user.id);
    const txn = await dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId: user.id,
        accountId: account.id,
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        isSplit: true,
      }),
    );
    const split = await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: txn.id,
        kind: SplitKind.CATEGORY,
        categoryId: category.id,
        amount: -50,
      }),
    );

    await dataSource.getRepository(Category).delete(category.id);

    const reloaded = await dataSource.manager.findOneByOrFail(
      TransactionSplit,
      { id: split.id },
    );
    expect(reloaded.categoryId).toBeNull();
  });
});
