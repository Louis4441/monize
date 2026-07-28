import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Account } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

describe("TransactionsService transfers (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let fromAccountId: string;
  let toAccountId: string;

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

    const fromAccount = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: 5000,
      currentBalance: 5000,
    });
    fromAccountId = fromAccount.id;

    const toAccount = await createTestAccount(dataSource, userId, {
      name: "Savings",
      openingBalance: 2000,
      currentBalance: 2000,
    });
    toAccountId = toAccount.id;
  });

  describe("createTransfer()", () => {
    it("should create linked transactions and update both balances", async () => {
      const result = await withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId,
          transactionDate: "2026-01-15",
          amount: 500,
          fromCurrencyCode: "USD",
        }),
      );

      // Verify two linked transactions created
      expect(result.fromTransaction).toBeDefined();
      expect(result.toTransaction).toBeDefined();
      expect(Number(result.fromTransaction.amount)).toBe(-500);
      expect(Number(result.toTransaction.amount)).toBe(500);
      expect(result.fromTransaction.isTransfer).toBe(true);
      expect(result.toTransaction.isTransfer).toBe(true);
      expect(result.fromTransaction.linkedTransactionId).toBe(
        result.toTransaction.id,
      );
      expect(result.toTransaction.linkedTransactionId).toBe(
        result.fromTransaction.id,
      );

      // Verify balances
      const fromAccount = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const toAccount = await dataSource.manager.findOne(Account, {
        where: { id: toAccountId },
      });
      expect(fromAccount!.currentBalance).toBe(4500);
      expect(toAccount!.currentBalance).toBe(2500);
    });

    it("should apply exchange rate for cross-currency transfers", async () => {
      const cadAccount = await createTestAccount(dataSource, userId, {
        name: "CAD Account",
        currencyCode: "CAD",
        openingBalance: 0,
        currentBalance: 0,
      });

      const result = await withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId: cadAccount.id,
          transactionDate: "2026-01-15",
          amount: 100,
          fromCurrencyCode: "USD",
          toCurrencyCode: "CAD",
          exchangeRate: 1.35,
        }),
      );

      expect(Number(result.fromTransaction.amount)).toBe(-100);
      expect(Number(result.toTransaction.amount)).toBe(135);
      expect(result.toTransaction.currencyCode).toBe("CAD");

      // Verify balances
      const fromAccount = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const cadAccountUpdated = await dataSource.manager.findOne(Account, {
        where: { id: cadAccount.id },
      });
      expect(fromAccount!.currentBalance).toBe(4900);
      expect(cadAccountUpdated!.currentBalance).toBe(135);
    });
  });

  describe("removeTransfer()", () => {
    it("should delete both transactions and reverse both balances", async () => {
      const result = await withUserContext(userId, () =>
        service.createTransfer(userId, {
          fromAccountId,
          toAccountId,
          transactionDate: "2026-01-15",
          amount: 300,
          fromCurrencyCode: "USD",
        }),
      );

      // Balances: from=4700, to=2300
      await withUserContext(userId, () =>
        service.removeTransfer(userId, result.fromTransaction.id),
      );

      // Balances should be restored
      const fromAccount = await dataSource.manager.findOne(Account, {
        where: { id: fromAccountId },
      });
      const toAccount = await dataSource.manager.findOne(Account, {
        where: { id: toAccountId },
      });
      expect(fromAccount!.currentBalance).toBe(5000);
      expect(toAccount!.currentBalance).toBe(2000);

      // Both transactions should be deleted
      const remaining = await dataSource.manager.find(Transaction, {
        where: { userId },
      });
      expect(remaining).toHaveLength(0);
    });
  });
});
