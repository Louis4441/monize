import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters here and is load-bearing. `securities.module` sits in a
// require cycle with the accounts and currencies graphs, and requiring the
// module before the service it provides leaves `HoldingsService` undefined when
// Nest reads InvestmentTransactionsService's parameter metadata -- the failure
// reads as "the argument at index [3] is not available". The service comes
// first, as in `investment-transactions.integration.spec.ts`, and the report
// services (which reach `currencies/exchange-rate.service` through
// `report-currency.service`) come after both.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { AnomalyReportsService } from "@/built-in-reports/anomaly-reports.service";
import { ComparisonReportsService } from "@/built-in-reports/comparison-reports.service";
import { DataQualityReportsService } from "@/built-in-reports/data-quality-reports.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { MonthlyCategoryBreakdownService } from "@/built-in-reports/monthly-category-breakdown.service";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { TaxRecurringReportsService } from "@/built-in-reports/tax-recurring-reports.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import {
  InvestmentAction,
  InvestmentTransaction,
} from "@/securities/entities/investment-transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * INV-REPORT-001 against a real PostgreSQL database: a report's account scope is
 * investment LINKAGE, never account type.
 *
 * An INVESTMENT account is a pair -- an `INVESTMENT_CASH` sleeve holding real
 * money and an `INVESTMENT_BROKERAGE` sleeve holding securities -- so the old
 * `AND a.account_type != 'INVESTMENT'` deleted the cash sleeve's whole ledger
 * from fifteen report queries, salary deposits included (issue #1257). The
 * rows that must go are the cash legs a trade generates, which the account-type
 * filter never described in the first place.
 *
 * The unit specs mock `manager.query`, so they can only assert the text of the
 * SQL. This suite runs it: it reproduces the issue's scenario with the real
 * writer (`InvestmentTransactionsService.create` posts the cash leg) and checks
 * both directions -- what must now appear, and what must still not.
 */
describe("built-in reports and investment cash accounts (integration)", () => {
  let module: TestingModule;
  let spending: SpendingReportsService;
  let income: IncomeReportsService;
  let comparison: ComparisonReportsService;
  let anomalies: AnomalyReportsService;
  let taxRecurring: TaxRecurringReportsService;
  let dataQuality: DataQualityReportsService;
  let breakdown: MonthlyCategoryBreakdownService;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;

  let userId: string;
  let cashSleeveId: string;
  let brokerageId: string;
  let chequingId: string;
  let salaryCategoryId: string;
  let groceriesCategoryId: string;
  let securityId: string;

  const MONTH = "2026-03";
  const START = "2026-03-01";
  const END = "2026-03-31";

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);

    // The report services read the ledger with raw SQL and take only a
    // DataSource and a currency resolver, so they are constructed directly.
    // Reaching them through `BuiltInReportsModule` pulls the
    // accounts/transactions/currencies module cycle in behind them, which the
    // integration harness cannot build. Every fixture is USD, so no exchange
    // rate is ever looked up and an empty rate list is the honest stub.
    const currency = new ReportCurrencyService(dataSource, {
      getLatestRates: async () => [],
    } as never);
    spending = new SpendingReportsService(dataSource, currency);
    income = new IncomeReportsService(dataSource, currency);
    comparison = new ComparisonReportsService(dataSource, currency);
    anomalies = new AnomalyReportsService(dataSource, currency);
    taxRecurring = new TaxRecurringReportsService(dataSource, currency);
    dataQuality = new DataQualityReportsService(dataSource, currency);
    breakdown = new MonthlyCategoryBreakdownService(dataSource, currency);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "security_prices",
      "securities",
      "transaction_splits",
      "transactions",
      "investment_transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const cash = await createTestAccount(dataSource, userId, {
      name: "TFSA - Cash",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, cash.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    cashSleeveId = cash.id;

    const brokerage = await createTestAccount(dataSource, userId, {
      name: "TFSA - Investments",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cashSleeveId,
    });
    brokerageId = brokerage.id;

    const chequing = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: 5000,
      currentBalance: 5000,
    });
    chequingId = chequing.id;

    salaryCategoryId = (
      await createTestCategory(dataSource, userId, {
        name: "Employment Income",
        isIncome: true,
      })
    ).id;
    groceriesCategoryId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;

    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    const tx = dataSource.manager.create(Transaction, {
      userId,
      accountId: cashSleeveId,
      transactionDate: "2026-03-10",
      amount: -100,
      currencyCode: "USD",
      status: TransactionStatus.UNRECONCILED,
      isTransfer: false,
      isSplit: false,
      ...overrides,
    } as Partial<Transaction>);
    return dataSource.manager.save(tx);
  }

  /**
   * The scenario from issue #1257: $1,000 of employment income paid straight
   * into the cash sleeve of an investment account.
   */
  async function insertSleeveSalary(): Promise<Transaction> {
    return insertTransaction({
      amount: 1000,
      categoryId: salaryCategoryId,
      payeeName: "Acme Payroll",
      description: "March salary",
    });
  }

  /**
   * A trade through the real writer. With no funding account the cash leg lands
   * in the linked sleeve; with one it lands in that account instead -- which is
   * how investment-generated cash reaches an ordinary chequing ledger, where no
   * account-type predicate could ever have recognised it.
   */
  async function createTrade(
    action: InvestmentAction,
    overrides: {
      date?: string;
      quantity?: number;
      price?: number;
      fundingAccountId?: string;
    } = {},
  ): Promise<InvestmentTransaction> {
    return withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageId,
        action,
        transactionDate: overrides.date ?? "2026-03-12",
        securityId,
        quantity: overrides.quantity ?? 10,
        price: overrides.price ?? 50,
        commission: 0,
        ...(overrides.fundingAccountId
          ? { fundingAccountId: overrides.fundingAccountId }
          : {}),
      } as any),
    );
  }

  async function createBuy(
    date = "2026-03-12",
    quantity = 10,
    price = 50,
  ): Promise<InvestmentTransaction> {
    return createTrade(InvestmentAction.BUY, { date, quantity, price });
  }

  /** The cash row a trade generated, asserted to be where the test expects. */
  async function generatedLeg(
    trade: InvestmentTransaction,
    expectedAccountId: string,
  ): Promise<Transaction> {
    const leg = await dataSource.manager.findOneOrFail(Transaction, {
      where: { id: trade.transactionId as string },
    });
    expect(leg.accountId).toBe(expectedAccountId);
    expect(leg.categoryId).toBeNull();
    expect(leg.isTransfer).toBe(false);
    return leg;
  }

  describe("the reported bug", () => {
    it("counts sleeve income in Cash Flow and excludes the trade's cash leg", async () => {
      await insertSleeveSalary();
      const buy = await createBuy();

      // The writer really did post a cash leg into the sleeve -- otherwise the
      // exclusion below would be proving nothing.
      const leg = await dataSource.manager.findOneOrFail(Transaction, {
        where: { id: buy.transactionId as string },
      });
      expect(leg.accountId).toBe(cashSleeveId);
      expect(Number(leg.amount)).toBe(-500);
      expect(leg.categoryId).toBeNull();

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
      expect(cashFlow.totals.expenses).toBe(0);
      expect(cashFlow.totals.net).toBe(1000);
      expect(cashFlow.data).toEqual([
        { month: MONTH, income: 1000, expenses: 0, net: 1000 },
      ]);
    });

    it("lists the sleeve's income category in Income by Source", async () => {
      await insertSleeveSalary();
      await createBuy();

      const result = await withUserContext(userId, () =>
        income.getIncomeBySource(userId, START, END),
      );

      expect(result.totalIncome).toBe(1000);
      expect(result.data).toEqual([
        expect.objectContaining({
          categoryId: salaryCategoryId,
          categoryName: "Employment Income",
          total: 1000,
        }),
      ]);
    });

    it("counts sleeve spending by category without an Uncategorized bucket for the trade", async () => {
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      await createBuy();

      const result = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      expect(result.data).toEqual([
        expect.objectContaining({ categoryId: groceriesCategoryId, total: 60 }),
      ]);
      expect(result.totalSpending).toBe(60);
    });

    it("does not offer the generated trade payee as a merchant", async () => {
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      const buy = await createBuy();

      const leg = await dataSource.manager.findOneOrFail(Transaction, {
        where: { id: buy.transactionId as string },
      });
      expect(leg.payeeName).toContain("AAPL");

      const result = await withUserContext(userId, () =>
        spending.getSpendingByPayee(userId, START, END),
      );

      const payees = result.data.map((row) => row.payeeName);
      expect(payees).toEqual(["Corner Store"]);
    });
  });

  /**
   * The Cash Flow page issues three requests -- the monthly aggregate, the
   * inflow breakdown and the outflow breakdown -- and every one of them carried
   * the account-type predicate. A per-query fix that left them disagreeing would
   * show a chart and two tables that do not add up, so the reconciliation is
   * asserted rather than assumed.
   */
  describe("the Cash Flow page's three queries", () => {
    it("reconcile with each other over the same range", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      await insertTransaction({
        accountId: chequingId,
        amount: -40,
        categoryId: groceriesCategoryId,
        payeeName: "Bakery",
      });
      await createBuy();

      const [cashFlow, bySource, byCategory] = await withUserContext(
        userId,
        async () =>
          Promise.all([
            income.getIncomeVsExpenses(userId, START, END),
            income.getIncomeBySource(userId, START, END),
            spending.getSpendingByCategory(userId, START, END),
          ]),
      );

      expect(cashFlow.totals.income).toBe(1000);
      expect(cashFlow.totals.expenses).toBe(100);
      expect(bySource.totalIncome).toBe(cashFlow.totals.income);
      expect(byCategory.totalSpending).toBe(cashFlow.totals.expenses);
    });
  });

  /**
   * The claim across the whole catalogue rather than report by report: adding a
   * trade to a sleeve that already holds ordinary income and ordinary spending
   * changes no report's answer. Every endpoint under `built-in-reports` that
   * reads the transaction ledger is in the list; a new one belongs here too.
   */
  describe("every report", () => {
    async function everyReport(): Promise<Record<string, unknown>> {
      return withUserContext(userId, async () => ({
        spendingByCategory: await spending.getSpendingByCategory(
          userId,
          START,
          END,
        ),
        spendingByPayee: await spending.getSpendingByPayee(userId, START, END),
        monthlySpendingTrend: await spending.getMonthlySpendingTrend(
          userId,
          START,
          END,
        ),
        incomeBySource: await income.getIncomeBySource(userId, START, END),
        incomeVsExpenses: await income.getIncomeVsExpenses(userId, START, END),
        yearOverYear: await comparison.getYearOverYear(userId, 2),
        weekendVsWeekday: await comparison.getWeekendVsWeekday(
          userId,
          START,
          END,
        ),
        spendingAnomalies: await anomalies.getSpendingAnomalies(userId, 2),
        taxSummary: await taxRecurring.getTaxSummary(userId, 2026),
        recurringExpenses: await taxRecurring.getRecurringExpenses(userId, 1),
        billPaymentHistory: await taxRecurring.getBillPaymentHistory(
          userId,
          START,
          END,
        ),
        uncategorized: await dataQuality.getUncategorizedTransactions(
          userId,
          START,
          END,
        ),
        duplicates: await dataQuality.getDuplicateTransactions(
          userId,
          START,
          END,
        ),
        monthlyCategoryBreakdown: await breakdown.getMonthlyCategoryBreakdown(
          userId,
          START,
          END,
        ),
      }));
    }

    it("answers the same with and without a trade in the sleeve", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });

      const before = await everyReport();
      await createBuy();
      const after = await everyReport();

      expect(after).toEqual(before);
    });

    it("sees the sleeve's own rows in the first place", async () => {
      // Guards the test above from passing because every report is empty --
      // which is exactly what the defect produced.
      await insertSleeveSalary();
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      // An ordinary account alongside, so the test also says the fix left
      // non-investment accounts alone.
      await insertTransaction({
        accountId: chequingId,
        amount: -40,
        categoryId: groceriesCategoryId,
        payeeName: "Bakery",
      });

      const snapshot = JSON.stringify(await everyReport());

      expect(snapshot).toContain("Corner Store");
      expect(snapshot).toContain("Employment Income");
      expect(snapshot).toContain("Bakery");
    });
  });

  describe("what stays excluded", () => {
    it("keeps a brokerage-sleeve row out of Cash Flow", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        accountId: brokerageId,
        amount: 999,
        categoryId: salaryCategoryId,
        payeeName: "Stray brokerage row",
      });

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
    });

    it("keeps a trade's cash leg out of Uncategorized, and keeps a real one in", async () => {
      await createBuy();
      const manual = await insertTransaction({
        amount: -25,
        categoryId: null,
        payeeName: "Unfiled sleeve fee",
      });

      const result = await withUserContext(userId, () =>
        dataQuality.getUncategorizedTransactions(userId, START, END),
      );

      expect(result.transactions.map((t) => t.id)).toEqual([manual.id]);
      // The list and the summary are two queries over one predicate; a
      // difference between them is the defect this asserts against.
      expect(result.summary.totalCount).toBe(1);
      expect(result.summary.expenseCount).toBe(1);
      expect(result.summary.expenseTotal).toBe(25);
    });

    it("does not report two identical trade legs as duplicate transactions", async () => {
      // Two partial fills at the same price on the same day: identical cash
      // legs, and neither is editable from the cash register.
      await createBuy("2026-03-12", 10, 50);
      await createBuy("2026-03-12", 10, 50);

      const result = await withUserContext(userId, () =>
        dataQuality.getDuplicateTransactions(userId, START, END),
      );

      expect(result.groups).toEqual([]);
    });

    it("keeps a trade's cash leg out of an ordinary funding account's report", async () => {
      // The inverse of issue #1257, same root: an explicit funding account puts
      // generated investment cash in a CHEQUING ledger, where the old
      // account-type predicate could not see it at all. Before the fix this
      // month reported 1000 of expenses that nobody spent.
      await insertTransaction({
        accountId: chequingId,
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      const buy = await createTrade(InvestmentAction.BUY, {
        quantity: 10,
        price: 100,
        fundingAccountId: chequingId,
      });
      const leg = await generatedLeg(buy, chequingId);
      expect(Number(leg.amount)).toBe(-1000);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.expenses).toBe(60);
      expect(cashFlow.totals.income).toBe(0);
    });

    it("keeps a dividend paid into an ordinary account out of income", async () => {
      const dividend = await createTrade(InvestmentAction.DIVIDEND, {
        quantity: 1,
        price: 30,
        fundingAccountId: chequingId,
      });
      const leg = await generatedLeg(dividend, chequingId);
      expect(Number(leg.amount)).toBe(30);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );
      const bySource = await withUserContext(userId, () =>
        income.getIncomeBySource(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(0);
      expect(bySource.data).toEqual([]);
      expect(bySource.totalIncome).toBe(0);
    });

    it("keeps a SELL's cash credit out of income", async () => {
      await insertSleeveSalary();
      const sell = await createTrade(InvestmentAction.SELL, {
        quantity: 4,
        price: 75,
      });
      const leg = await generatedLeg(sell, cashSleeveId);
      expect(Number(leg.amount)).toBe(300);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
    });

    it("counts ordinary cash on a standalone investment account", async () => {
      // A .mny import produces these: account_type INVESTMENT with no sub-type,
      // holding both securities and its own cash. It IS the cash side, so the
      // brokerage-sleeve exclusion must not reach it.
      const standalone = await createTestAccount(dataSource, userId, {
        name: "Legacy Brokerage",
        openingBalance: 0,
        currentBalance: 0,
      });
      await dataSource.manager.update(Account, standalone.id, {
        accountType: AccountType.INVESTMENT,
        accountSubType: null,
      });
      await insertTransaction({
        accountId: standalone.id,
        amount: 250,
        categoryId: salaryCategoryId,
        payeeName: "Acme Payroll",
      });

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(250);
    });

    it("still excludes a VOID row in the sleeve", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        amount: 5000,
        categoryId: salaryCategoryId,
        payeeName: "Voided bonus",
        status: TransactionStatus.VOID,
      });

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
    });

    it("still excludes a transfer split line in the sleeve", async () => {
      const parent = await insertTransaction({
        amount: -260,
        isSplit: true,
        categoryId: null,
        payeeName: "Sleeve sweep",
      });
      const groceries = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.CATEGORY,
        categoryId: groceriesCategoryId,
        amount: -60,
      } as Partial<TransactionSplit>);
      const transferOut = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.TRANSFER,
        transferAccountId: chequingId,
        amount: -200,
      } as Partial<TransactionSplit>);
      await dataSource.manager.save([groceries, transferOut]);
      // The counterpart leg the transfer writer creates in the target account.
      await insertTransaction({
        accountId: chequingId,
        amount: 200,
        isTransfer: true,
        categoryId: null,
      });

      const byCategory = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      expect(byCategory.totalSpending).toBe(60);
    });

    it("does not count an investment line embedded in a split", async () => {
      // Shaped as `createEmbeddedForSplit` writes it: the investment line
      // carries no category and its InvestmentTransaction points at the split
      // (`transaction_id` stays null, the parent's amount is the cash side).
      const parent = await insertTransaction({
        amount: -560,
        isSplit: true,
        categoryId: null,
        payeeName: "Brokerage statement",
      });
      const groceries = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.CATEGORY,
        categoryId: groceriesCategoryId,
        amount: -60,
      } as Partial<TransactionSplit>);
      const investmentLine = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.INVESTMENT,
        categoryId: null,
        amount: -500,
      } as Partial<TransactionSplit>);
      await dataSource.manager.save([groceries, investmentLine]);
      await dataSource.manager.save(
        dataSource.manager.create(InvestmentTransaction, {
          userId,
          accountId: brokerageId,
          transactionSplitId: investmentLine.id,
          securityId,
          action: InvestmentAction.BUY,
          transactionDate: "2026-03-10",
          quantity: 10,
          price: 50,
          commission: 0,
          totalAmount: -500,
          exchangeRate: 1,
          status: TransactionStatus.UNRECONCILED,
        } as Partial<InvestmentTransaction>),
      );

      const byCategory = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      expect(byCategory.data).toEqual([
        expect.objectContaining({ categoryId: groceriesCategoryId, total: 60 }),
      ]);
      expect(byCategory.totalSpending).toBe(60);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );
      expect(cashFlow.totals.expenses).toBe(60);
    });
  });
});
