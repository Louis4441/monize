import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { IncomeReportsService } from "./income-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("IncomeReportsService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: IncomeReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockIncomeCategory: Category = {
    id: "cat-income",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Salary",
    description: null,
    icon: null,
    color: "#5733FF",
    isIncome: true,
    isSystem: false,
    createdAt: new Date("2025-01-03"),
  };

  const mockParentCategory: Category = {
    id: "cat-parent",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Employment",
    description: null,
    icon: null,
    color: "#FF5733",
    isIncome: true,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockChildCategory: Category = {
    id: "cat-child",
    userId: mockUserId,
    parentId: "cat-parent",
    parent: null,
    children: [],
    name: "Bonuses",
    description: null,
    icon: null,
    color: "#33FF57",
    isIncome: true,
    isSystem: false,
    createdAt: new Date("2025-01-02"),
  };

  const mockExchangeRates = [
    { fromCurrency: "EUR", toCurrency: "USD", rate: 1.1 },
    { fromCurrency: "GBP", toCurrency: "USD", rate: 1.27 },
    { fromCurrency: "USD", toCurrency: "CAD", rate: 1.36 },
  ];

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    exchangeRateService = {
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [Transaction, transactionsRepository as never],
        [Category, categoriesRepository as never],
        [UserPreference, userPreferenceRepository as never],
      ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncomeReportsService,
        ReportCurrencyService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<IncomeReportsService>(IncomeReportsService);
  });

  // ---------------------------------------------------------------------------
  // getIncomeBySource
  // ---------------------------------------------------------------------------
  describe("getIncomeBySource", () => {
    it("returns empty data when no income transactions exist", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalIncome).toBe(0);
    });

    it("keeps subcategories separate with 'Parent: Child' name format", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "1000.00" },
        { category_id: "cat-parent", currency_code: "USD", total: "4000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(2);
      const child = result.data.find((d) => d.categoryId === "cat-child");
      const parent = result.data.find((d) => d.categoryId === "cat-parent");
      expect(child).toBeDefined();
      expect(child!.categoryName).toBe("Employment: Bonuses");
      expect(child!.total).toBe(1000);
      expect(parent).toBeDefined();
      expect(parent!.categoryName).toBe("Employment");
      expect(parent!.total).toBe(4000);
      expect(result.totalIncome).toBe(5000);
    });

    it("skips uncategorized rows in JS (SQL already filters them out)", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "200.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalIncome).toBe(0);
    });

    it("skips rows whose category_id is unknown", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "nonexistent-id",
          currency_code: "USD",
          total: "300.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalIncome).toBe(0);
    });

    it("converts income amounts from foreign currencies", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "GBP", total: "1000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // GBP->USD rate is 1.27, so 1000 GBP = 1270 USD
      expect(result.data[0].total).toBe(1270);
    });

    it("limits results to top 15 sources", async () => {
      const rawResults = Array.from({ length: 20 }, (_, i) => ({
        category_id: `cat-inc-${i}`,
        currency_code: "USD",
        total: `${(20 - i) * 100}.00`,
      }));
      const categories: Category[] = Array.from({ length: 20 }, (_, i) => ({
        id: `cat-inc-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Income Source ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: true,
        isSystem: false,
        createdAt: new Date(),
      }));
      scopedManager.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(categories);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(15);
    });

    it("passes startDate parameter when provided", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-06-01", "2025-12-31");

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-06-01"]);
    });

    it("omits startDate filter when undefined", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, undefined, "2025-12-31");

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(queryCall[0]).not.toContain("$3");
    });

    it("uses the subcategory's own color (does not roll up to parent)", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "500.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].categoryId).toBe("cat-child");
      expect(result.data[0].color).toBe("#33FF57");
    });

    it("merges multi-currency rows for the same subcategory", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "USD", total: "100.00" },
        { category_id: "cat-income", currency_code: "EUR", total: "200.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBe("cat-income");
      // 100 USD + 200 EUR * 1.1 = 320
      expect(result.data[0].total).toBe(320);
    });

    it("filters by is_income = true in the SQL query (income categories only)", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-01-01", "2025-12-31");

      const sql = scopedManager.query.mock.calls[0][0];
      expect(sql).toContain("INNER JOIN categories c");
      expect(sql).toContain("c.is_income = true");
    });

    it("rounds totals to 2 decimal places", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "USD", total: "33.333" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(33.333);
    });

    it("filters out the asset value change category in the SQL query", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-01-01", "2025-12-31");

      const sql = scopedManager.query.mock.calls[0][0];
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("asset_category_id");
      expect(sql).toMatch(
        /ax\.asset_category_id\s*=\s*COALESCE\(ts\.category_id,\s*t\.category_id\)/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getIncomeVsExpenses
  // ---------------------------------------------------------------------------
  describe("getIncomeVsExpenses", () => {
    const row = (
      periodStart: string,
      income: string,
      expenses: string,
      currency = "USD",
    ) => ({
      period_start: periodStart,
      currency_code: currency,
      income,
      expenses,
    });

    it("returns a bar per month in the window when nothing happened", async () => {
      // A month with no rows earned and spent zero. That is a bar of height
      // zero, not a gap the chart closes up, so the window is enumerated and
      // the query's rows are placed into it.
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-03-31",
      );

      expect(result.data.map((d) => d.period)).toEqual([
        "2025-01",
        "2025-02",
        "2025-03",
      ]);
      expect(result.data.every((d) => d.income === 0 && d.expenses === 0)).toBe(
        true,
      );
      expect(result.totals).toMatchObject({ income: 0, expenses: 0, net: 0 });
    });

    it("calculates income, expenses and net per bucket", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "5000.00", "3000.00"),
        row("2025-02-01", "5000.00", "3500.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-02-28",
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({
        period: "2025-01",
        periodStart: "2025-01-01",
        periodEnd: "2025-01-31",
        income: 5000,
        expenses: 3000,
        net: 2000,
      });
      expect(result.totals).toMatchObject({
        income: 10000,
        expenses: 6500,
        net: 3500,
        knownIncome: 10000,
      });
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual([]);
    });

    it("carries the dates a bar covers, so a drill-down needs no arithmetic", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-02-01",
        "2025-02-28",
      );

      expect(result.data[0].periodStart).toBe("2025-02-01");
      expect(result.data[0].periodEnd).toBe("2025-02-28");
    });

    it("merges multiple currency rows for the same bucket", async () => {
      // EUR->USD is 1.1 in the fixture rates.
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "500.00"),
        row("2025-01-01", "1000.00", "500.00", "EUR"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].income).toBe(2100);
      expect(result.data[0].expenses).toBe(1050);
    });

    it("withholds the totals and names the currency when a rate is missing", async () => {
      // JPY has no rate in the fixture. The report used to add raw yen to a
      // dollar bar, which is a wrong number rather than a missing one.
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "500.00"),
        row("2025-01-01", "300000.00", "100000.00", "JPY"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.totals.income).toBeNull();
      expect(result.totals.expenses).toBeNull();
      expect(result.totals.net).toBeNull();
      expect(result.totals.knownIncome).toBe(1000);
      expect(result.totals.knownExpenses).toBe(500);
      expect(result.totals.knownNet).toBe(500);
      expect(result.data[0].income).toBe(1000);
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
    });

    it("handles negative net (expenses exceed income)", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "1500.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.data[0].net).toBe(-500);
      expect(result.totals.net).toBe(-500);
    });

    it("rounds every monetary value to money precision", async () => {
      // Money is decimal(20,4), so `roundMoney` keeps four places, not two.
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.55555", "500.44444"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.data[0].income).toBe(1000.5556);
      expect(result.data[0].expenses).toBe(500.4444);
    });

    it("passes startDate as a parameter when provided", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(mockUserId, "2025-06-01", "2025-06-30");

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("t.transaction_date >= $3");
      expect(params[2]).toBe("2025-06-01");
    });

    it("omits the startDate filter when it is undefined", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "100.00", "0.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const [sql] = scopedManager.query.mock.calls[0];
      expect(sql).not.toContain("transaction_date >=");
      // With no window there is nothing to enumerate, so the answer is the
      // buckets that actually had rows.
      expect(result.data.map((d) => d.period)).toEqual(["2025-01"]);
    });

    it("restricts the window to the requested accounts", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          accountIds: ["acct-1", "acct-2"],
        },
      );

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("t.account_id = ANY($4::uuid[])");
      expect(params[3]).toEqual(["acct-1", "acct-2"]);
    });

    it("adds no account filter for an empty selection", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          accountIds: [],
        },
      );

      expect(scopedManager.query.mock.calls[0][0]).not.toContain(
        "account_id = ANY",
      );
    });

    it("buckets by week when asked, honouring the user's first day", async () => {
      // 2025-01-06 is a Monday. Asking for weeks starting Sunday shifts the
      // grouping, and the enumeration has to agree with it.
      scopedManager.query.mockResolvedValue([
        row("2025-01-05", "700.00", "200.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-05",
        "2025-01-18",
        { bucket: "week", weekStartsOn: 0 },
      );

      expect(result.data.map((d) => d.period)).toEqual([
        "2025-01-05",
        "2025-01-12",
      ]);
      expect(result.data[0]).toMatchObject({
        periodStart: "2025-01-05",
        periodEnd: "2025-01-11",
        income: 700,
      });
      // Sunday start: the offset that lands it on a Monday before truncation.
      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("date_trunc('week'");
      expect(params[2]).toBe(1);
      expect(sql).toContain("make_interval(days => $3::int)");
    });

    it("groups by month with no week shifting when the bucket is a month", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(mockUserId, "2025-01-01", "2025-01-31");

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("date_trunc('month'");
      expect(sql).not.toContain("date_trunc('week'");
      // The week offset is not bound at all: PostgreSQL infers a parameter's
      // type from where it appears, so an unused one is a query that will not
      // even plan ("could not determine data type of parameter $3").
      expect(params).toEqual([mockUserId, "2025-01-31", "2025-01-01"]);
      expect(sql).not.toContain("make_interval");
    });
  });
});
