import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ReportCurrencyService,
  RawCategoryAggregate,
  RawPeriodAggregate,
} from "./report-currency.service";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import {
  IncomeBySourceResponse,
  IncomeSourceItem,
  IncomeExpensePeriodItem,
  IncomeVsExpensesResponse,
} from "./dto";
import {
  bucketStartSql,
  enumerateIncomeExpensePeriods,
  periodKeyForStart,
  weekTruncOffsetDays,
  type IncomeExpenseBucket,
  type WeekStartsOn,
} from "./income-expense-buckets";
import { investmentExclusionSql } from "../common/investment-filter.util";

/**
 * Investment scope is LINKAGE, never account type (INV-REPORT-001, issue #1257):
 * the cash sleeve of an INVESTMENT account holds ordinary money, while the cash
 * leg a trade generated is not spending or income. Both halves of the predicate,
 * and why the account type cannot express either, live in
 * `common/investment-filter.util.ts`.
 */
const INVESTMENT_EXCLUSION = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
  splitAlias: "ts",
});

@Injectable()
export class IncomeReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  async getIncomeBySource(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<IncomeBySourceResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(COALESCE(ts.amount, t.amount)) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      INNER JOIN categories c ON c.id = COALESCE(ts.category_id, t.category_id)
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND c.is_income = true
        AND COALESCE(ts.amount, t.amount) > 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = COALESCE(ts.category_id, t.category_id)
        )
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id), t.currency_code`;

    const rawResults: RawCategoryAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const categoryTotals = new Map<
      string,
      { total: number; category: Category }
    >();

    for (const row of rawResults) {
      const total = this.currencyService.convertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const categoryId = row.category_id;
      if (!categoryId) continue;

      const category = categoryMap.get(categoryId);
      if (!category) continue;

      const parentCategory = category.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const displayName = parentCategory
        ? `${parentCategory.name}: ${category.name}`
        : category.name;

      const existing = categoryTotals.get(category.id);
      if (existing) {
        existing.total += total;
      } else {
        categoryTotals.set(category.id, {
          total,
          category: { ...category, name: displayName } as Category,
        });
      }
    }

    const data: IncomeSourceItem[] = Array.from(categoryTotals.entries())
      .map(([id, { total, category }]) => ({
        categoryId: id,
        categoryName: category.name,
        color: category.color || null,
        total: roundMoney(total),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const totalIncome = sumMoney(data.map((item) => item.total));

    return {
      data,
      totalIncome: roundMoney(totalIncome),
    };
  }

  /**
   * Income against expenses over a window, bucketed by month or by week.
   *
   * The one answer the Income vs Expenses report and the dashboard widget both
   * draw. The widget used to bucket and classify paged transactions in the
   * browser, and disagreed with this report about the same period: it read no
   * VOID status, applied no asset-category exclusion, kept a split's transfer
   * line, and decided what was an investment from the account TYPE rather than
   * from the row (INV-REPORT-001). Every rule that decides which rows count and
   * which side they fall on therefore lives here, in the query.
   *
   * `options.accountIds` restricts the window; `options.bucket` and
   * `options.weekStartsOn` set how wide a bar is. Both exist because the widget
   * offers them -- a caller that re-buckets the answer is deciding which
   * transaction belongs to which bar, which is half of deciding what the bar
   * says.
   */
  async getIncomeVsExpenses(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options: {
      accountIds?: string[];
      bucket?: IncomeExpenseBucket;
      weekStartsOn?: WeekStartsOn;
    } = {},
  ): Promise<IncomeVsExpensesResponse> {
    const { accountIds, bucket = "month", weekStartsOn = 1 } = options;
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    // The week-start offset is a parameter so the grouping expression stays a
    // constant string: see `weekTruncOffsetDays` for what it shifts. It is bound
    // only when a week bucket actually references it -- PostgreSQL infers a
    // parameter's type from where it appears, so an unused $3 is
    // "could not determine data type of parameter $3" rather than a harmless
    // extra.
    const params: (string | string[] | number | undefined)[] = [
      userId,
      endDate,
    ];
    if (bucket === "week") params.push(weekTruncOffsetDays(weekStartsOn));
    const bucketStart = bucketStartSql(
      bucket,
      "t.transaction_date",
      `$${params.length}`,
    );

    let query = `
      SELECT
        ${bucketStart} as period_start,
        t.currency_code,
        SUM(CASE
          WHEN c.is_income = true THEN COALESCE(ts.amount, t.amount)
          WHEN c.is_income = false THEN 0
          WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount)
          ELSE 0
        END) as income,
        SUM(CASE
          WHEN c.is_income = false THEN -1 * COALESCE(ts.amount, t.amount)
          WHEN c.is_income = true THEN 0
          WHEN COALESCE(ts.amount, t.amount) < 0 THEN ABS(COALESCE(ts.amount, t.amount))
          ELSE 0
        END) as expenses
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN categories c ON c.id = COALESCE(ts.category_id, t.category_id)
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = COALESCE(ts.category_id, t.category_id)
        )
    `;

    if (startDate) {
      query += ` AND t.transaction_date >= $${params.length + 1}`;
      params.push(startDate);
    }

    // An empty array would match nothing, which is not what "no filter" means.
    if (accountIds && accountIds.length > 0) {
      query += ` AND t.account_id = ANY($${params.length + 1}::uuid[])`;
      params.push(accountIds);
    }

    query += `
      GROUP BY ${bucketStart}, t.currency_code
      ORDER BY period_start
    `;

    const rawResults: RawPeriodAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const byPeriod = new Map<string, { income: number; expenses: number }>();
    /**
     * Currencies with no rate into the reporting currency, and how many
     * aggregate rows that cost.
     *
     * An excluded row is not a smaller number: the bar it belonged to is
     * missing part of its height and the window's totals are unknowable, so the
     * gap is reported rather than absorbed. `convertAmount` returned the amount
     * UNCONVERTED here, adding foreign units straight into a home-currency bar.
     */
    const missingCurrencies = new Set<string>();
    let excludedCount = 0;

    for (const row of rawResults) {
      const income = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.income),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const expenses = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.expenses),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      // One rate serves both halves of the row, so they fail together.
      if (income === null || expenses === null) {
        missingCurrencies.add(row.currency_code);
        excludedCount += 1;
        continue;
      }
      const key = periodKeyForStart(row.period_start, bucket);
      const existing = byPeriod.get(key);
      if (existing) {
        existing.income += income;
        existing.expenses += expenses;
      } else {
        byPeriod.set(key, { income, expenses });
      }
    }

    // Every bucket in the window, including the empty ones: a week nothing
    // happened in earned and spent zero, which is a bar of height zero rather
    // than a gap the chart closes up. Without a start date there is no window to
    // enumerate, so the answer is the buckets that had rows.
    const periods = startDate
      ? enumerateIncomeExpensePeriods(startDate, endDate, bucket, weekStartsOn)
      : [...byPeriod.keys()].sort().map((period) => ({
          period,
          periodStart: bucket === "month" ? `${period}-01` : period,
          periodEnd: bucket === "month" ? `${period}-01` : period,
        }));

    const data: IncomeExpensePeriodItem[] = periods.map((period) => {
      const found = byPeriod.get(period.period) ?? { income: 0, expenses: 0 };
      return {
        ...period,
        income: roundMoney(found.income),
        expenses: roundMoney(found.expenses),
        net: roundMoney(found.income - found.expenses),
      };
    });

    const knownIncome = roundMoney(sumMoney(data.map((item) => item.income)));
    const knownExpenses = roundMoney(
      sumMoney(data.map((item) => item.expenses)),
    );
    const knownNet = roundMoney(sumMoney(data.map((item) => item.net)));
    const complete = excludedCount === 0;

    return {
      data,
      totals: {
        income: complete ? knownIncome : null,
        expenses: complete ? knownExpenses : null,
        net: complete ? knownNet : null,
        knownIncome,
        knownExpenses,
        knownNet,
      },
      currency: defaultCurrency,
      missingCurrencies: [...missingCurrencies].sort(),
      excludedCount,
    };
  }
}
