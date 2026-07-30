import { ConflictException, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { CurrenciesService } from "../../currencies/currencies.service";
import { UsersService } from "../../users/users.service";
import { ImportPostProcessingService } from "../import-post-processing.service";
import { MnyStagedFileMissingError } from "./mny-errors";
import { JobRunContext, MnyImportJobService } from "./mny-import-job.service";
import { MnyImportService } from "./mny-import.service";
import { MnyParsedFile, MnyParserService } from "./mny-parser.service";
import { MnyStagingService } from "./mny-staging.service";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";
import {
  applyDeferredClosures,
  writeAccounts,
  writeCategories,
  writePayees,
} from "./writers/write-reference";
import {
  writeAccountBalances,
  writeTransactions,
} from "./writers/write-transactions";
import { writeInvestments, writeSecurities } from "./writers/write-investments";
import {
  writeExchangeRates,
  writeSecurityPrices,
} from "./writers/write-prices";
import { HoldingsService } from "../../securities/holdings.service";

jest.mock("../../common/db/scoped-db", () => ({
  withScopedDb: jest.fn(),
  runOutsideActiveScopedManager: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("../../common/db/with-context", () => ({
  withUserContext: <T>(_userId: string, fn: () => T): T => fn(),
  withSystemContext: <T>(fn: () => T): T => fn(),
}));

jest.mock("./writers/write-reference", () => ({
  writeAccounts: jest.fn(),
  writeCategories: jest.fn(),
  writePayees: jest.fn(),
  applyDeferredClosures: jest.fn(),
}));

jest.mock("./writers/write-transactions", () => ({
  writeTransactions: jest.fn(),
  writeAccountBalances: jest.fn(),
}));

jest.mock("./writers/write-investments", () => ({
  writeSecurities: jest.fn(),
  writeInvestments: jest.fn(),
}));

jest.mock("./writers/write-prices", () => ({
  writeSecurityPrices: jest.fn(),
  writeExchangeRates: jest.fn(),
}));

const mockedScopedDb = withScopedDb as jest.MockedFunction<typeof withScopedDb>;
const mockedWriteAccounts = writeAccounts as jest.MockedFunction<
  typeof writeAccounts
>;
const mockedWriteCategories = writeCategories as jest.MockedFunction<
  typeof writeCategories
>;
const mockedWritePayees = writePayees as jest.MockedFunction<
  typeof writePayees
>;
const mockedWriteTransactions = writeTransactions as jest.MockedFunction<
  typeof writeTransactions
>;
const mockedWriteBalances = writeAccountBalances as jest.MockedFunction<
  typeof writeAccountBalances
>;
const mockedClosures = applyDeferredClosures as jest.MockedFunction<
  typeof applyDeferredClosures
>;
const mockedWriteSecurities = writeSecurities as jest.MockedFunction<
  typeof writeSecurities
>;
const mockedWriteInvestments = writeInvestments as jest.MockedFunction<
  typeof writeInvestments
>;
const mockedWritePrices = writeSecurityPrices as jest.MockedFunction<
  typeof writeSecurityPrices
>;
const mockedWriteRates = writeExchangeRates as jest.MockedFunction<
  typeof writeExchangeRates
>;

/**
 * The orchestration around the writers: what runs before the job row exists,
 * what runs inside the one import transaction, and what the verification report
 * says. The writers themselves and the SQL they emit are covered by their own
 * specs and by `test/integration/mny-import.integration.spec.ts`.
 */
function parsedFile(overrides: Partial<MnyParsedFile> = {}): MnyParsedFile {
  return {
    era: "money2005",
    passwordProtected: false,
    options: DEFAULT_MNY_IMPORT_OPTIONS,
    baseCurrency: "CAD",
    accounts: {
      baseCurrency: "CAD",
      currencyCodes: ["CAD"],
      accounts: [
        {
          key: "acct-1",
          handle: 1,
          name: "Chequing",
          moneyName: "Chequing",
          accountType: "CHEQUING",
          accountSubType: null,
          currencyCode: "CAD",
          openingBalance: 0,
          creditLimit: null,
          closed: false,
          closedDate: null,
          favourite: false,
          description: null,
          linkedKey: null,
        },
      ],
      keyByHandle: new Map([[1, "acct-1"]]),
      currencyByHandle: new Map([[1, "CAD"]]),
      skipped: 0,
      warnings: [],
    },
    transactions: {
      transactions: [],
      referencedPayees: new Set(),
      referencedCategories: new Set(),
      transfersLinked: 4,
      skipped: 1,
      deferredInvestments: 2,
      warnings: [],
    },
    categories: {
      categories: [
        {
          handle: 10,
          parentName: null,
          name: "Groceries",
          fullName: "Groceries",
          isIncome: false,
        },
      ],
      byHandle: new Map([
        [
          10,
          {
            handle: 10,
            parentName: null,
            name: "Groceries",
            fullName: "Groceries",
            isIncome: false,
          },
        ],
      ]),
      skipped: 0,
      warnings: [],
    },
    payees: {
      payees: [{ handle: 5, name: "Loblaws" }],
      nameByHandle: new Map([[5, "Loblaws"]]),
      skipped: 0,
      warnings: [],
    },
    securities: {
      securities: [
        {
          handle: 20,
          symbol: "VOO",
          moneySymbol: "VOO",
          name: "Vanguard S&P 500",
          currencyCode: "CAD",
          skipPriceUpdates: false,
        },
      ],
      byHandle: new Map(),
      skipped: 0,
      warnings: [],
    },
    investments: {
      transactions: [],
      referencedSecurities: new Set(),
      referencedPayees: new Set(),
      referencedCategories: new Set(),
      transfersPaired: 0,
      splitsApplied: 0,
      skipped: 0,
      warnings: [],
    },
    rawPrices: [],
    rawExchangeRates: [],
    currencyByHandle: new Map([[1, "CAD"]]),
    holdingChecks: [],
    currencyCodes: ["CAD"],
    expectedBalances: new Map([["acct-1", 120.5]]),
    transactionCounts: new Map([["acct-1", 3]]),
    investmentCounts: new Map(),
    fileCounts: {
      accounts: 1,
      payees: 1,
      categories: 1,
      securities: 0,
      securityPrices: 0,
      exchangeRates: 0,
      bills: 0,
      transactions: 0,
    },
    missingTables: [],
    missingFields: [],
    warnings: [],
    ...overrides,
  } as MnyParsedFile;
}

describe("MnyImportService", () => {
  let staging: Record<string, jest.Mock>;
  let parser: Record<string, jest.Mock>;
  let jobs: Record<string, jest.Mock>;
  let postProcessing: Record<string, jest.Mock>;
  let usersService: Record<string, jest.Mock>;
  let currencies: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let accountRepo: Record<string, jest.Mock>;
  let preferenceRepo: Record<string, jest.Mock>;
  let service: MnyImportService;

  const context: JobRunContext = {
    jobId: "job-1",
    userId: "user-1",
    reportProgress: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    staging = {
      findInfo: jest.fn().mockResolvedValue({ id: "staged-1" }),
      loadBytes: jest.fn().mockResolvedValue(Buffer.from("bytes")),
      remove: jest.fn().mockResolvedValue(true),
    };
    parser = { parse: jest.fn().mockReturnValue(parsedFile()) };
    jobs = {
      hasActiveJob: jest.fn().mockResolvedValue(false),
      create: jest.fn().mockResolvedValue({ id: "job-1" }),
      runClaimed: jest.fn().mockResolvedValue(true),
    };
    postProcessing = { run: jest.fn().mockResolvedValue(undefined) };
    usersService = { deleteData: jest.fn().mockResolvedValue(undefined) };
    currencies = {
      ensureSystemCurrency: jest.fn().mockResolvedValue(undefined),
    };

    accountRepo = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: "account-1", currentBalance: "120.5000" }]),
    };
    preferenceRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };

    const manager = {
      getRepository: jest.fn((entity: { name?: string }) =>
        entity?.name === "UserPreference" ? preferenceRepo : accountRepo,
      ),
    } as unknown as EntityManager;
    mockedScopedDb.mockImplementation((_dataSource, fn) => fn(manager));

    mockedWriteAccounts.mockResolvedValue({
      idByKey: new Map([["acct-1", "account-1"]]),
      created: 1,
      reused: 0,
    });
    mockedWriteCategories.mockResolvedValue({
      idByFullName: new Map([["Groceries", "category-1"]]),
      created: 1,
    });
    mockedWritePayees.mockResolvedValue({
      idByName: new Map([["Loblaws", "payee-1"]]),
      created: 1,
    });
    mockedWriteTransactions.mockResolvedValue({
      transactionsCreated: 7,
      splitsCreated: 2,
      linksApplied: 4,
      affectedAccountIds: new Set(["account-1"]),
    });
    mockedWriteBalances.mockResolvedValue(1);
    mockedClosures.mockResolvedValue(0);
    mockedWriteSecurities.mockResolvedValue({
      idByHandle: new Map([[20, "security-1"]]),
      created: 1,
      reused: 0,
    });
    mockedWriteInvestments.mockResolvedValue({
      investmentTransactionsCreated: 3,
      cashTransactionsCreated: 2,
      linksApplied: 1,
      affectedAccountIds: new Set(["account-1"]),
      brokerageAccountIds: new Set(["account-1"]),
    });
    mockedWritePrices.mockResolvedValue(11);
    mockedWriteRates.mockResolvedValue(5);

    holdingsService = {
      rebuildAccountsFromTransactions: jest.fn().mockResolvedValue(undefined),
    };

    service = new MnyImportService(
      {} as DataSource,
      staging as unknown as MnyStagingService,
      parser as unknown as MnyParserService,
      jobs as unknown as MnyImportJobService,
      postProcessing as unknown as ImportPostProcessingService,
      usersService as unknown as UsersService,
      currencies as unknown as CurrenciesService,
      holdingsService as unknown as HoldingsService,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  afterEach(() => jest.clearAllMocks());

  describe("start", () => {
    it("rejects a staged file that expired or never belonged to the caller", async () => {
      staging.findInfo.mockResolvedValue(null);

      await expect(
        service.start("user-1", { stagedFileId: "staged-1" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(jobs.create).not.toHaveBeenCalled();
    });

    it("refuses a second concurrent import", async () => {
      jobs.hasActiveJob.mockResolvedValue(true);

      await expect(
        service.start("user-1", { stagedFileId: "staged-1" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(jobs.create).not.toHaveBeenCalled();
    });

    it("creates the job with resolved options and starts it in the background", async () => {
      const job = await service.start("user-1", { stagedFileId: "staged-1" });

      expect(job).toEqual({ id: "job-1" });
      expect(jobs.create).toHaveBeenCalledWith(
        "user-1",
        "staged-1",
        expect.objectContaining({ wipeExistingData: false }),
      );
      expect(jobs.runClaimed).toHaveBeenCalledWith(
        "user-1",
        "job-1",
        expect.any(Function),
      );
    });

    it("wipes before the job exists, and never stores the credentials", async () => {
      await service.start("user-1", {
        stagedFileId: "staged-1",
        options: { wipeExistingData: true },
        wipeCredentials: { password: "hunter2" },
      });

      expect(usersService.deleteData).toHaveBeenCalledWith("user-1", {
        password: "hunter2",
        oidcIdToken: undefined,
        deleteAccounts: true,
        deleteCategories: true,
        deletePayees: true,
      });
      // The wipe re-authenticates, so its credentials must not reach
      // import_jobs.options.
      const [, , options] = jobs.create.mock.calls[0];
      expect(JSON.stringify(options)).not.toContain("hunter2");
      expect(usersService.deleteData.mock.invocationCallOrder[0]).toBeLessThan(
        jobs.create.mock.invocationCallOrder[0],
      );
    });

    it("fails the request, not a background job, when re-authentication fails", async () => {
      usersService.deleteData.mockRejectedValue(new Error("bad password"));

      await expect(
        service.start("user-1", {
          stagedFileId: "staged-1",
          options: { wipeExistingData: true },
        }),
      ).rejects.toThrow("bad password");
      expect(jobs.create).not.toHaveBeenCalled();
    });

    it("does not wipe when the option is off", async () => {
      await service.start("user-1", { stagedFileId: "staged-1" });

      expect(usersService.deleteData).not.toHaveBeenCalled();
    });

    it("logs rather than throws when the background start fails", async () => {
      const error = jest.spyOn(service["logger"], "error");
      jobs.runClaimed.mockRejectedValue(new Error("pool exhausted"));

      await service.start("user-1", { stagedFileId: "staged-1" });
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("pool exhausted"),
      );
    });

    it("runs the import as the job body", async () => {
      const runImport = jest
        .spyOn(service, "runImport")
        .mockResolvedValue({} as never);

      await service.start("user-1", { stagedFileId: "staged-1" });
      await jobs.runClaimed.mock.calls[0][2](context);

      expect(runImport).toHaveBeenCalledWith(
        "user-1",
        "staged-1",
        expect.objectContaining({ wipeExistingData: false }),
        context,
      );
    });
  });

  describe("runImport", () => {
    const run = () =>
      service.runImport(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        context,
      );

    it("fails cleanly when the staged bytes are gone", async () => {
      staging.loadBytes.mockResolvedValue(null);

      await expect(run()).rejects.toBeInstanceOf(MnyStagedFileMissingError);
    });

    it("re-parses the staged bytes rather than trusting the preview", async () => {
      await run();

      expect(parser.parse).toHaveBeenCalledWith(
        expect.objectContaining({
          buffer: expect.any(Buffer),
          options: DEFAULT_MNY_IMPORT_OPTIONS,
          userDefaultCurrency: "CAD",
        }),
      );
    });

    it("falls back to USD when the user has no currency preference", async () => {
      preferenceRepo.findOne.mockResolvedValue(null);

      await run();

      expect(parser.parse).toHaveBeenCalledWith(
        expect.objectContaining({ userDefaultCurrency: "USD" }),
      );
    });

    // Not just the accounts' currencies: a security can be denominated in one no
    // account uses, and `exchange_rates` has a foreign key to `currencies` on
    // both sides.
    it("ensures every currency the file names before the transaction opens", async () => {
      parser.parse.mockReturnValue(
        parsedFile({ currencyCodes: ["CAD", "USD"] }),
      );

      await run();

      expect(currencies.ensureSystemCurrency).toHaveBeenCalledWith("CAD");
      expect(currencies.ensureSystemCurrency).toHaveBeenCalledWith("USD");
    });

    it("writes reference data, then transactions, then balances, then closures", async () => {
      await run();

      const order = [
        mockedWriteAccounts,
        mockedWriteCategories,
        mockedWritePayees,
        mockedWriteTransactions,
        mockedWriteBalances,
        mockedClosures,
      ].map((mock) => mock.mock.invocationCallOrder[0]);

      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("resolves the transaction writer's handle maps from the reference writers", async () => {
      await run();

      const [, , input] = mockedWriteTransactions.mock.calls[0];
      expect(input.accountIdByKey.get("acct-1")).toBe("account-1");
      expect(input.categoryIdByHandle.get(10)).toBe("category-1");
      expect(input.payeeIdByHandle.get(5)).toBe("payee-1");
      expect(input.payeeNameByHandle.get(5)).toBe("Loblaws");
    });

    it("forwards chunk progress to the job", async () => {
      await run();

      const [, , input] = mockedWriteTransactions.mock.calls[0];
      await input.onProgress?.(500, 1000);

      expect(context.reportProgress).toHaveBeenCalledWith({
        phase: "transactions",
        processed: 500,
        total: 1000,
      });
    });

    it("writes balances only for accounts that got an id", async () => {
      parser.parse.mockReturnValue(
        parsedFile({
          expectedBalances: new Map([
            ["acct-1", 120.5],
            ["acct-excluded", 9],
          ]),
        }),
      );

      await run();

      const [, balances] = mockedWriteBalances.mock.calls[0];
      expect([...balances]).toEqual([["account-1", 120.5]]);
    });

    it("hands post-processing only the accounts that were touched", async () => {
      await run();

      expect(postProcessing.run).toHaveBeenCalledWith(
        "user-1",
        false,
        new Set(["account-1"]),
      );
    });

    it("deletes the staged bytes once the import succeeds", async () => {
      await run();

      expect(staging.remove).toHaveBeenCalledWith("user-1", "staged-1");
    });

    it("reports what was created and skipped", async () => {
      const result = await run();

      expect(result).toMatchObject({
        accountsCreated: 1,
        categoriesCreated: 1,
        payeesCreated: 1,
        transactionsCreated: 7,
        splitsCreated: 2,
        transfersLinked: 4,
        securitiesCreated: 1,
        investmentTransactionsCreated: 3,
        pricesImported: 11,
        exchangeRatesImported: 5,
        // Phase 3 fills this; reported as zero so the shape does not change.
        billsCreated: 0,
        existingDataRemoved: false,
        skipped: { accounts: 0, payees: 0, categories: 0, transactions: 1 },
      });
    });

    it("verifies each account's balance against the file", async () => {
      const result = await run();

      expect(result.verification).toEqual([
        {
          accountName: "Chequing",
          accountId: "account-1",
          expectedBalance: 120.5,
          importedBalance: 120.5,
          delta: 0,
          transactionCount: 3,
          matches: true,
        },
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("raises a balance mismatch as a warning", async () => {
      accountRepo.find.mockResolvedValue([
        { id: "account-1", currentBalance: "100.0000" },
      ]);

      const result = await run();

      expect(result.verification[0]).toMatchObject({
        delta: -20.5,
        matches: false,
      });
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "balanceMismatch", count: 1 }),
      ]);
    });

    it("treats an account that never got a row as an unverifiable zero", async () => {
      const base = parsedFile();
      parser.parse.mockReturnValue(
        parsedFile({
          accounts: {
            ...base.accounts,
            accounts: [
              ...base.accounts.accounts,
              {
                ...base.accounts.accounts[0],
                key: "acct-2",
                handle: 2,
                name: "Visa",
                moneyName: "Visa",
              },
            ],
          },
          expectedBalances: new Map([
            ["acct-1", 120.5],
            ["acct-2", 40],
          ]),
        }),
      );

      const result = await run();

      expect(result.verification[1]).toMatchObject({
        accountName: "Visa",
        accountId: null,
        importedBalance: 0,
        delta: -40,
        matches: false,
      });
    });

    it("skips the balance query entirely when nothing was written", async () => {
      mockedWriteAccounts.mockResolvedValue({
        idByKey: new Map(),
        created: 0,
        reused: 0,
      });

      const result = await run();

      expect(result.verification).toEqual([]);
      expect(accountRepo.find).not.toHaveBeenCalled();
    });

    it("carries the parser's own warnings into the report", async () => {
      parser.parse.mockReturnValue(
        parsedFile({
          warnings: [{ code: "unknownAccountType", subject: "at=99" }],
        }),
      );

      const result = await run();

      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "unknownAccountType", count: 1 }),
      );
    });

    it("records that existing data was wiped when the option was set", async () => {
      const result = await service.runImport(
        "user-1",
        "staged-1",
        { ...DEFAULT_MNY_IMPORT_OPTIONS, wipeExistingData: true },
        context,
      );

      expect(result.existingDataRemoved).toBe(true);
    });
  });

  describe("investments", () => {
    const run = () =>
      service.runImport(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        context,
      );

    it("writes securities and investments after transactions, prices last", async () => {
      await run();

      const order = [
        mockedWriteTransactions,
        mockedWriteSecurities,
        mockedWriteInvestments,
        mockedWritePrices,
        mockedWriteRates,
        mockedWriteBalances,
        mockedClosures,
      ].map((mock) => mock.mock.invocationCallOrder[0]);

      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("gives the investment writer the same handle maps the transactions used", async () => {
      await run();

      const [, , input] = mockedWriteInvestments.mock.calls[0];
      expect(input.securityIdByHandle.get(20)).toBe("security-1");
      expect(input.categoryIdByHandle.get(10)).toBe("category-1");
      expect(input.payeeIdByHandle.get(5)).toBe("payee-1");
      expect(input.symbolByHandle.get(20)).toBe("VOO");
    });

    // Holdings come only from the canonical rebuild, on the import
    // transaction's own manager: a second connection would deadlock against it.
    it("rebuilds holdings for the brokerage accounts inside the transaction", async () => {
      await run();

      expect(
        holdingsService.rebuildAccountsFromTransactions,
      ).toHaveBeenCalledWith("user-1", ["account-1"], expect.anything());
      const [, , runner] = (
        holdingsService.rebuildAccountsFromTransactions as jest.Mock
      ).mock.calls[0];
      expect(runner.manager).toBeDefined();
    });

    it("does not rebuild holdings when no brokerage account was touched", async () => {
      mockedWriteInvestments.mockResolvedValue({
        investmentTransactionsCreated: 0,
        cashTransactionsCreated: 0,
        linksApplied: 0,
        affectedAccountIds: new Set<string>(),
        brokerageAccountIds: new Set<string>(),
      });

      await run();

      expect(
        holdingsService.rebuildAccountsFromTransactions,
      ).not.toHaveBeenCalled();
    });

    it("honours the price and exchange-rate toggles", async () => {
      parser.parse.mockReturnValue(
        parsedFile({
          options: {
            ...DEFAULT_MNY_IMPORT_OPTIONS,
            importPrices: false,
            importExchangeRates: false,
          },
        }),
      );

      const result = await run();

      expect(mockedWritePrices).not.toHaveBeenCalled();
      expect(mockedWriteRates).not.toHaveBeenCalled();
      expect(result.pricesImported).toBe(0);
      expect(result.exchangeRatesImported).toBe(0);
    });

    it("asks post-processing for the price backfill only when investments landed", async () => {
      const base = parsedFile();
      parser.parse.mockReturnValue(
        parsedFile({
          investments: {
            ...base.investments,
            transactions: [
              {
                id: "inv-1",
              } as unknown as (typeof base.investments.transactions)[number],
            ],
          },
        }),
      );

      await run();

      expect(postProcessing.run).toHaveBeenCalledWith(
        "user-1",
        true,
        expect.any(Set),
      );
    });

    it("reports each holding against Money's open lots", async () => {
      accountRepo.find.mockImplementation((options: { select?: string[] }) =>
        options.select?.includes("quantity")
          ? [
              {
                accountId: "account-1",
                securityId: "security-1",
                quantity: "10.00000000",
              },
            ]
          : [{ id: "account-1", currentBalance: "120.5000" }],
      );
      parser.parse.mockReturnValue(
        parsedFile({
          holdingChecks: [
            {
              accountKey: "acct-1",
              securityHandle: 20,
              symbol: "VOO",
              lotQuantity: 10,
              replayQuantity: 10,
              delta: 0,
              matches: true,
            },
          ],
        }),
      );

      const result = await run();

      expect(result.holdings).toEqual([
        {
          accountName: "Chequing",
          symbol: "VOO",
          lotQuantity: 10,
          replayQuantity: 10,
          importedQuantity: 10,
          delta: 0,
          matches: true,
        },
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("raises a holdings mismatch as a warning rather than failing", async () => {
      accountRepo.find.mockImplementation((options: { select?: string[] }) =>
        options.select?.includes("quantity")
          ? [
              {
                accountId: "account-1",
                securityId: "security-1",
                quantity: "4.00000000",
              },
            ]
          : [{ id: "account-1", currentBalance: "120.5000" }],
      );
      parser.parse.mockReturnValue(
        parsedFile({
          holdingChecks: [
            {
              accountKey: "acct-1",
              securityHandle: 20,
              symbol: "VOO",
              lotQuantity: 10,
              replayQuantity: 10,
              delta: 0,
              matches: true,
            },
          ],
        }),
      );

      const result = await run();

      expect(result.holdings[0]).toMatchObject({
        importedQuantity: 4,
        delta: -6,
        matches: false,
      });
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "holdingsMismatch", count: 1 }),
      );
    });

    it("reports no holdings when the file has no LOT table", async () => {
      const result = await run();

      expect(result.holdings).toEqual([]);
    });
  });
});
