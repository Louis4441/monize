import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";

import { Account } from "@/accounts/entities/account.entity";
import { Category } from "@/categories/entities/category.entity";
import { Payee } from "@/payees/entities/payee.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { UsersService } from "@/users/users.service";
import { CurrenciesService } from "@/currencies/currencies.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { SecurityPriceService } from "@/securities/security-price.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { ImportPostProcessingService } from "@/import/import-post-processing.service";
import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { ImportStagedFile } from "@/import/mny/entities/import-staged-file.entity";
import { MnyImportJobService } from "@/import/mny/mny-import-job.service";
import { MnyImportService } from "@/import/mny/mny-import.service";
import { MnyParserService } from "@/import/mny/mny-parser.service";
import { MnyStagingService } from "@/import/mny/mny-staging.service";
import { readMnyFixture } from "@/import/mny/__fixtures__/mny-fixtures";
import {
  mnyAccount,
  mnyCategory,
  mnyCurrency,
  mnyDefaults,
  mnyPayee,
  mnySplit,
  mnyTransaction,
  mnyTransfer,
  referenceData,
  transactionData,
} from "@/import/mny/__fixtures__/mny-row-builders";
import {
  mapAccounts,
  mapCategories,
  mapPayees,
} from "@/import/mny/map/map-reference";
import { mapTransactions } from "@/import/mny/map/map-transactions";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "@/import/mny/model/mny-import-options";
import {
  applyDeferredClosures,
  writeAccounts,
  writeCategories,
  writePayees,
} from "@/import/mny/writers/write-reference";
import {
  writeAccountBalances,
  writeTransactions,
} from "@/import/mny/writers/write-transactions";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The writers against a real database.
 *
 * Two halves, for two different reasons. The writer specs drive the mappers'
 * real output through the real INSERT path, because that is where foreign keys,
 * check constraints and the self-referencing transfer link actually bite -- and
 * the committed `.mny` fixtures contain no banking transactions at all, so the
 * interesting cases (transfer pairs, loan splits) can only come from plain-object
 * rows. The end-to-end half then imports a real fixture through
 * `MnyImportService` so the whole chain, verification report included, is
 * exercised on real bytes.
 */
describe("mny writers (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;

  const TABLES = [
    "transaction_splits",
    "transactions",
    "import_jobs",
    "import_staged_files",
    "accounts",
    "categories",
    "payees",
  ];

  /** Mirrors CurrenciesService.ensureSystemCurrency, which the FKs require. */
  async function ensureCurrency(code: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ($1, $1, $1, 2, true) ON CONFLICT (code) DO NOTHING`,
      [code],
    );
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
        TypeOrmModule.forFeature([
          Account,
          Category,
          Payee,
          Transaction,
          TransactionSplit,
          UserPreference,
          ImportJob,
          ImportStagedFile,
        ]),
      ],
      providers: [
        MnyStagingService,
        MnyParserService,
        MnyImportJobService,
        MnyImportService,
        // Real: its balance recalculation is the cross-check the verification
        // report compares against.
        ImportPostProcessingService,
        // Stubbed: these reach external price and FX providers.
        {
          provide: NetWorthService,
          useValue: { recalculateAccount: async () => undefined },
        },
        {
          provide: SecurityPriceService,
          useValue: {
            backfillHistoricalPrices: async () => undefined,
            backfillTransactionPrices: async () => undefined,
          },
        },
        {
          provide: ExchangeRateService,
          useValue: { backfillHistoricalRates: async () => undefined },
        },
        { provide: UsersService, useValue: { deleteData: jest.fn() } },
        {
          provide: CurrenciesService,
          useValue: {
            ensureSystemCurrency: (code: string) => ensureCurrency(code),
          },
        },
      ],
    }).compile();

    dataSource = module.get(DataSource);
    userId = (await createTestUserDirect(dataSource)).id;
    await ensureCurrency("USD");
    await ensureCurrency("GBP");
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, TABLES);
  });

  /** Runs `fn` in a user-scoped transaction, as the import itself does. */
  const inTransaction = <T>(
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> => withUserContext(userId, () => withScopedDb(dataSource, fn));

  // -------------------------------------------------------------------------
  // Reference writers
  // -------------------------------------------------------------------------

  describe("writeAccounts", () => {
    const accountsFrom = (rows: Parameters<typeof mnyAccount>[0][]) =>
      mapAccounts(
        referenceData({
          currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
          defaults: mnyDefaults({ defaultCurrency: 1 }),
          accounts: rows.map((row) => mnyAccount(row)),
        }),
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );

    it("creates accounts with their type, currency and opening balance", async () => {
      const mapped = accountsFrom([
        { handle: 1, type: 1, name: "Visa", creditLimit: 3000 },
        { handle: 2, type: 0, name: "Chequing", openingBalance: 1200.5 },
      ]);

      const written = await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      expect(written.created).toBe(2);
      const rows = await dataSource
        .getRepository(Account)
        .find({ where: { userId }, order: { name: "ASC" } });
      expect(
        rows.map((row) => [row.name, row.accountType, row.creditLimit]),
      ).toEqual([
        ["Chequing", "CHEQUING", null],
        ["Visa", "CREDIT_CARD", 3000],
      ]);
      expect(rows.find((row) => row.name === "Chequing")!.openingBalance).toBe(
        1200.5,
      );
    });

    it("cross-links an investment pair in both directions", async () => {
      const mapped = accountsFrom([{ handle: 1, type: 5, name: "TFSA" }]);

      await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      const rows = await dataSource
        .getRepository(Account)
        .find({ where: { userId } });
      const cash = rows.find((row) => row.name === "TFSA - Cash")!;
      const brokerage = rows.find((row) => row.name === "TFSA - Brokerage")!;
      expect(cash.linkedAccountId).toBe(brokerage.id);
      expect(brokerage.linkedAccountId).toBe(cash.id);
      expect(cash.accountSubType).toBe("INVESTMENT_CASH");
      expect(brokerage.accountSubType).toBe("INVESTMENT_BROKERAGE");
    });

    it("reuses an account the user already has, rather than duplicating it", async () => {
      const mapped = accountsFrom([{ handle: 1, name: "Chequing" }]);
      await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      const second = await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );

      expect(second.created).toBe(0);
      expect(second.reused).toBe(1);
      expect(
        await dataSource.getRepository(Account).count({ where: { userId } }),
      ).toBe(1);
    });

    it("leaves an account open until closures are applied deliberately", async () => {
      // A closed account rejects balance updates, so closure has to come last.
      const mapped = accountsFrom([
        { handle: 1, name: "Old", closed: true, closedOn: "2020-06-30" },
      ]);

      const written = await inTransaction((manager) =>
        writeAccounts(manager, userId, mapped.accounts),
      );
      const beforeClosure = await dataSource
        .getRepository(Account)
        .findOne({ where: { userId, name: "Old" } });
      expect(beforeClosure!.isClosed).toBe(false);

      await inTransaction((manager) =>
        applyDeferredClosures(
          manager,
          userId,
          mapped.accounts,
          written.idByKey,
        ),
      );

      const afterClosure = await dataSource
        .getRepository(Account)
        .findOne({ where: { userId, name: "Old" } });
      expect(afterClosure!.isClosed).toBe(true);
      expect(String(afterClosure!.closedDate)).toContain("2020-06-30");
    });
  });

  describe("writeCategories", () => {
    const treeFrom = (rows: Parameters<typeof mnyCategory>[0][]) =>
      mapCategories(
        referenceData({
          categories: [
            mnyCategory({
              handle: 130,
              name: "INCOME",
              level: 0,
              categoryType: -1,
            }),
            mnyCategory({
              handle: 131,
              name: "EXPENSE",
              level: 0,
              categoryType: -1,
            }),
            ...rows.map((row) => mnyCategory(row)),
          ].sort((a, b) => a.level - b.level),
        }),
        null,
      );

    it("creates a parent and child, keeping Money's income flag", async () => {
      const mapped = treeFrom([
        { handle: 200, name: "Salary", level: 1, parent: 130, categoryType: 2 },
        { handle: 201, name: "Bonus", level: 2, parent: 200, categoryType: 2 },
        { handle: 202, name: "Rent", level: 1, parent: 131, categoryType: 0 },
      ]);

      const written = await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      expect(written.created).toBe(3);
      const rows = await dataSource
        .getRepository(Category)
        .find({ where: { userId } });
      const salary = rows.find((row) => row.name === "Salary")!;
      const bonus = rows.find((row) => row.name === "Bonus")!;
      const rent = rows.find((row) => row.name === "Rent")!;
      expect(bonus.parentId).toBe(salary.id);
      expect(salary.isIncome).toBe(true);
      // The QIF entity creator hardcodes isIncome false; this pipeline must not.
      expect(rent.isIncome).toBe(false);
    });

    it("reuses an existing category with the same name and parent", async () => {
      const mapped = treeFrom([
        { handle: 200, name: "Utilities", level: 1, parent: 131 },
      ]);
      await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      const second = await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      expect(second.created).toBe(0);
      expect(
        await dataSource.getRepository(Category).count({ where: { userId } }),
      ).toBe(1);
    });

    it("keeps same-named children under different parents distinct", async () => {
      const mapped = treeFrom([
        { handle: 200, name: "Car A", level: 1, parent: 131 },
        { handle: 201, name: "Car B", level: 1, parent: 131 },
        { handle: 202, name: "Fuel", level: 2, parent: 200 },
        { handle: 203, name: "Fuel", level: 2, parent: 201 },
      ]);

      const written = await inTransaction((manager) =>
        writeCategories(manager, userId, mapped.categories),
      );

      expect(written.created).toBe(4);
      expect(
        await dataSource
          .getRepository(Category)
          .count({ where: { userId, name: "Fuel" } }),
      ).toBe(2);
    });
  });

  describe("writePayees", () => {
    it("creates payees and reuses them on a second run", async () => {
      const mapped = mapPayees(
        [
          mnyPayee({ handle: 1, name: "Costco" }),
          mnyPayee({ handle: 2, name: "#" }),
        ],
        null,
      );

      const first = await inTransaction((manager) =>
        writePayees(manager, userId, mapped.payees),
      );
      const second = await inTransaction((manager) =>
        writePayees(manager, userId, mapped.payees),
      );

      expect(first.created).toBe(1);
      expect(second.created).toBe(0);
      const rows = await dataSource
        .getRepository(Payee)
        .find({ where: { userId } });
      expect(rows.map((row) => row.name)).toEqual(["Costco"]);
    });
  });

  // -------------------------------------------------------------------------
  // Transaction writer
  // -------------------------------------------------------------------------

  describe("writeTransactions", () => {
    /** Maps rows, writes the reference data, and returns what the writer needs. */
    async function setup(data: ReturnType<typeof transactionData>) {
      const reference = referenceData({
        currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
        defaults: mnyDefaults({ defaultCurrency: 1 }),
        accounts: [
          mnyAccount({ handle: 1, name: "Chequing" }),
          mnyAccount({ handle: 2, name: "Savings" }),
          mnyAccount({ handle: 9, type: 6, name: "Mortgage" }),
        ],
        payees: [mnyPayee({ handle: 30, name: "Bank" })],
        categories: [
          mnyCategory({
            handle: 131,
            name: "EXPENSE",
            level: 0,
            categoryType: -1,
          }),
          mnyCategory({ handle: 60, name: "Interest", level: 1, parent: 131 }),
          mnyCategory({ handle: 61, name: "Groceries", level: 1, parent: 131 }),
        ],
      });
      const accounts = mapAccounts(
        reference,
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );
      const transactions = mapTransactions({
        transactions: data,
        accountKeyByHandle: accounts.keyByHandle,
        currencyByHandle: accounts.currencyByHandle,
        bills: [],
      });
      const categories = mapCategories(reference, null);
      const payees = mapPayees(reference.payees, null);

      const written = await inTransaction(async (manager) => {
        const writtenAccounts = await writeAccounts(
          manager,
          userId,
          accounts.accounts,
        );
        const writtenCategories = await writeCategories(
          manager,
          userId,
          categories.categories,
        );
        const writtenPayees = await writePayees(manager, userId, payees.payees);
        return { writtenAccounts, writtenCategories, writtenPayees };
      });

      return {
        accounts,
        transactions,
        categories,
        payees,
        input: {
          transactions: transactions.transactions,
          accountIdByKey: written.writtenAccounts.idByKey,
          categoryIdByHandle: new Map(
            [...categories.byHandle].map(([handle, category]) => [
              handle,
              written.writtenCategories.idByFullName.get(category.fullName)!,
            ]),
          ),
          payeeIdByHandle: new Map(
            [...payees.nameByHandle].map(([handle, name]) => [
              handle,
              written.writtenPayees.idByName.get(name)!,
            ]),
          ),
          payeeNameByHandle: payees.nameByHandle,
        },
      };
    }

    it("writes a plain transaction with its payee, category and reference", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({
              handle: 1,
              account: 1,
              amount: -42.5,
              date: "2024-03-04",
              payee: 30,
              category: 61,
              memo: "Weekly shop",
              reference: "1042",
              clearedStatus: 1,
            }),
          ],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.transactionsCreated).toBe(1);
      const row = await dataSource.getRepository(Transaction).findOne({
        where: { userId },
        relations: { payee: true, category: true },
      });
      expect(row).toMatchObject({
        amount: "-42.5000",
        transactionDate: "2024-03-04",
        description: "Weekly shop",
        referenceNumber: "1042",
        status: "CLEARED",
        payeeName: "Bank",
      });
      expect(row!.payee!.name).toBe("Bank");
      expect(row!.category!.name).toBe("Groceries");
    });

    it("cross-links a transfer pair, which a per-row insert could not do", async () => {
      // linked_transaction_id is a self-referencing FK, so whichever side went
      // first would fail without the back-patch pass.
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -250 }),
            mnyTransaction({ handle: 2, account: 2, amount: 250 }),
          ],
          transfers: [mnyTransfer({ from: 1, to: 2 })],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.linksApplied).toBe(2);
      const rows = await dataSource
        .getRepository(Transaction)
        .find({ where: { userId }, order: { amount: "ASC" } });
      const [out, back] = rows;
      expect(out.isTransfer).toBe(true);
      expect(out.linkedTransactionId).toBe(back.id);
      expect(back.linkedTransactionId).toBe(out.id);
    });

    it("writes a loan payment as a transfer split plus its loan-side row", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -1500, payee: 30 }),
            mnyTransaction({ handle: 2, account: 1, amount: -400 }),
            mnyTransaction({
              handle: 3,
              account: 1,
              amount: -1100,
              category: 60,
              memo: "Interest",
            }),
            mnyTransaction({ handle: 4, account: 9, amount: 400 }),
          ],
          splits: [
            mnySplit({ parent: 1, child: 2, position: 0 }),
            mnySplit({ parent: 1, child: 3, position: 1 }),
          ],
          transfers: [mnyTransfer({ from: 2, to: 4 })],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.transactionsCreated).toBe(2);
      expect(written.splitsCreated).toBe(2);

      const payment = await dataSource
        .getRepository(Transaction)
        .findOne({ where: { userId, amount: -1500 as never } });
      const loanSide = await dataSource
        .getRepository(Transaction)
        .findOne({ where: { userId, amount: 400 as never } });
      const splits = await dataSource.getRepository(TransactionSplit).find({
        where: { transactionId: payment!.id },
        order: { amount: "ASC" },
      });
      const mortgage = await dataSource
        .getRepository(Account)
        .findOne({ where: { userId, name: "Mortgage" } });

      expect(payment!.isSplit).toBe(true);
      const principal = splits.find(
        (split) => split.kind === SplitKind.TRANSFER,
      )!;
      expect(principal).toMatchObject({
        transferAccountId: mortgage!.id,
        linkedTransactionId: loanSide!.id,
        categoryId: null,
      });
      // The far side points back at the parent payment, as it does for a
      // hand-entered transfer split.
      expect(loanSide!.linkedTransactionId).toBe(payment!.id);
      expect(loanSide!.isTransfer).toBe(true);
    });

    it("keeps a voided transaction, so nothing silently disappears", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -99, flags: 0x80 }),
          ],
        }),
      );

      await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      const row = await dataSource.getRepository(Transaction).findOne({
        where: { userId },
      });
      expect(row!.status).toBe("VOID");
    });

    it("writes more rows than one chunk holds", async () => {
      const rows = Array.from({ length: 1200 }, (_, index) =>
        mnyTransaction({
          handle: index + 1,
          account: 1,
          amount: -1,
          date: "2024-01-02",
        }),
      );
      const { input } = await setup(transactionData({ transactions: rows }));
      const progress: Array<[number, number]> = [];

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, {
          ...input,
          onProgress: async (processed, total) => {
            progress.push([processed, total]);
          },
        }),
      );

      expect(written.transactionsCreated).toBe(1200);
      expect(
        await dataSource
          .getRepository(Transaction)
          .count({ where: { userId } }),
      ).toBe(1200);
      // 500-row chunks, so three progress reports ending at the total.
      expect(progress).toEqual([
        [500, 1200],
        [1000, 1200],
        [1200, 1200],
      ]);
    });

    it("reports the accounts it touched, for post-import processing", async () => {
      const { input } = await setup(
        transactionData({
          transactions: [
            mnyTransaction({ handle: 1, account: 1, amount: -10 }),
            mnyTransaction({ handle: 2, account: 2, amount: -20 }),
          ],
        }),
      );

      const written = await inTransaction((manager) =>
        writeTransactions(manager, userId, input),
      );

      expect(written.affectedAccountIds.size).toBe(2);
    });
  });

  describe("writeAccountBalances", () => {
    it("writes each account's balance in one pass", async () => {
      const mapped = mapAccounts(
        referenceData({
          currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
          defaults: mnyDefaults({ defaultCurrency: 1 }),
          accounts: [
            mnyAccount({ handle: 1, name: "A" }),
            mnyAccount({ handle: 2, name: "B" }),
          ],
        }),
        DEFAULT_MNY_IMPORT_OPTIONS,
        "USD",
      );

      const written = await inTransaction(async (manager) => {
        const accounts = await writeAccounts(manager, userId, mapped.accounts);
        await writeAccountBalances(
          manager,
          new Map([
            [accounts.idByKey.get("acct-1")!, 1234.5678],
            [accounts.idByKey.get("acct-2")!, -99.99],
          ]),
        );
        return accounts;
      });

      const rows = await dataSource
        .getRepository(Account)
        .find({ where: { userId }, order: { name: "ASC" } });
      expect(rows.map((row) => row.currentBalance)).toEqual([
        1234.5678, -99.99,
      ]);
      expect(written.created).toBe(2);
    });

    it("does nothing for an empty balance set", async () => {
      await expect(
        inTransaction((manager) => writeAccountBalances(manager, new Map())),
      ).resolves.toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // End to end, on real Money bytes
  // -------------------------------------------------------------------------

  describe("MnyImportService on a real fixture", () => {
    let importService: MnyImportService;
    let staging: MnyStagingService;
    let jobs: MnyImportJobService;

    beforeAll(() => {
      importService = module.get(MnyImportService);
      staging = module.get(MnyStagingService);
      jobs = module.get(MnyImportJobService);
    });

    async function runImport(fixture: "money2002" | "money2008") {
      const staged = await withUserContext(userId, () =>
        staging.stage(userId, {
          filename: `${fixture}.mny`,
          data: readMnyFixture(fixture),
        }),
      );
      const job = await withUserContext(userId, () =>
        importService.start(userId, { stagedFileId: staged.id }),
      );

      // start() runs the body unawaited; wait for the row to settle.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await withUserContext(userId, () =>
          jobs.findOne(userId, job.id),
        );
        if (
          current &&
          current.status !== "pending" &&
          current.status !== "running"
        ) {
          return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("import job did not finish");
    }

    it("imports money2008.mny and reconciles every account", async () => {
      const job = await runImport("money2008");

      expect(job.status).toBe("completed");
      // One Money investment account -> one linked Monize pair.
      expect(job.result!.accountsCreated).toBe(2);
      expect(job.result!.verification).toHaveLength(2);
      for (const account of job.result!.verification) {
        expect(account.matches).toBe(true);
        expect(account.delta).toBe(0);
      }
    });

    it("reports the imported balance the database actually holds", async () => {
      const job = await runImport("money2002");

      const accounts = await dataSource
        .getRepository(Account)
        .find({ where: { userId } });
      for (const line of job.result!.verification) {
        const stored = accounts.find(
          (account) => account.id === line.accountId,
        );
        expect(stored).toBeDefined();
        expect(line.importedBalance).toBe(Number(stored!.currentBalance));
      }
    });

    it("deletes the staged file once the import completes", async () => {
      const before = await dataSource
        .getRepository(ImportStagedFile)
        .count({ where: { userId } });
      await runImport("money2008");
      const after = await dataSource
        .getRepository(ImportStagedFile)
        .count({ where: { userId } });

      expect(before).toBe(0);
      expect(after).toBe(0);
    });

    it("refuses to start a second import while one is in flight", async () => {
      const staged = await withUserContext(userId, () =>
        staging.stage(userId, {
          filename: "money2008.mny",
          data: readMnyFixture("money2008"),
        }),
      );
      await withUserContext(userId, () =>
        jobs.create(userId, staged.id, DEFAULT_MNY_IMPORT_OPTIONS),
      );

      await expect(
        withUserContext(userId, () =>
          importService.start(userId, { stagedFileId: staged.id }),
        ),
      ).rejects.toThrow(/already running/i);
    });

    it("refuses to start when the staged file is gone", async () => {
      await expect(
        withUserContext(userId, () =>
          importService.start(userId, {
            stagedFileId: "11111111-1111-4111-8111-111111111111",
          }),
        ),
      ).rejects.toThrow(/no longer available/i);
    });
  });
});
