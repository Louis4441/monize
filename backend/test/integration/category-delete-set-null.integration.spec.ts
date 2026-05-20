import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
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
//
// Deleting a user cascades to delete that user's categories (schema.sql
// declares categories.user_id ON DELETE CASCADE). The fix is that a
// category deletion must null out the category_id on any referencing
// transaction/split rather than block it. This asserts that contract
// directly across all four affected tables.
describe("Category delete -> SET NULL on referencing rows (integration)", () => {
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

  it("nulls category_id on transactions, splits and scheduled rows when the category is deleted", async () => {
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
        categoryId: category.id,
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
    const scheduledSplit = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduled.id,
        kind: SplitKind.CATEGORY,
        categoryId: category.id,
        amount: -25,
      }),
    );

    // Previously ON DELETE NO ACTION -> this threw a FK violation.
    await expect(
      dataSource.getRepository(Category).delete(category.id),
    ).resolves.toBeDefined();

    const [reTxn, reSplit, reSched, reSchedSplit] = await Promise.all([
      dataSource.manager.findOneByOrFail(Transaction, { id: txn.id }),
      dataSource.manager.findOneByOrFail(TransactionSplit, { id: split.id }),
      dataSource.manager.findOneByOrFail(ScheduledTransaction, {
        id: scheduled.id,
      }),
      dataSource.manager.findOneByOrFail(ScheduledTransactionSplit, {
        id: scheduledSplit.id,
      }),
    ]);

    expect(reTxn.categoryId).toBeNull();
    expect(reSplit.categoryId).toBeNull();
    expect(reSched.categoryId).toBeNull();
    expect(reSchedSplit.categoryId).toBeNull();
  });
});
