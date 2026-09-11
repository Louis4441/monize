import { ApiProperty } from "@nestjs/swagger";

/**
 * One month of the Cash Flow report, which buckets by month and nothing else.
 * Income vs Expenses answers at a granularity its caller chooses and uses
 * {@link IncomeExpensePeriodItem}.
 */
export class MonthlyIncomeExpenseItem {
  @ApiProperty({ example: "2024-01" })
  month: string;

  @ApiProperty({ example: 5000.0 })
  income: number;

  @ApiProperty({ example: 3500.0 })
  expenses: number;

  @ApiProperty({ example: 1500.0 })
  net: number;
}

/** One bar of Income vs Expenses: a month or a week, with the dates it covers. */
export class IncomeExpensePeriodItem {
  /** `YYYY-MM` for a month bucket, the week's first day for a week bucket. */
  @ApiProperty({ example: "2024-01" })
  period: string;

  /** First day the bar covers, inclusive. */
  @ApiProperty({ example: "2024-01-01" })
  periodStart: string;

  /** Last day the bar covers, inclusive. Drill-downs use the pair as-is. */
  @ApiProperty({ example: "2024-01-31" })
  periodEnd: string;

  /**
   * Money in over the period, in {@link IncomeVsExpensesResponse.currency}.
   * Rows that could not be converted are in none of the figures, so when
   * `missingCurrencies` is non-empty this is the part that converted.
   */
  @ApiProperty({ example: 5000.0 })
  income: number;

  @ApiProperty({ example: 3500.0 })
  expenses: number;

  @ApiProperty({ example: 1500.0 })
  net: number;
}

export class IncomeExpenseTotals {
  /**
   * Total money in over the window, or `null` when a row could not be
   * converted -- a missing rate makes the total unknowable, never smaller.
   */
  @ApiProperty({ example: 60000.0, nullable: true })
  income: number | null;

  @ApiProperty({ example: 42000.0, nullable: true })
  expenses: number | null;

  @ApiProperty({ example: 18000.0, nullable: true })
  net: number | null;

  /**
   * The part that did convert. Equals the field above it when nothing was
   * excluded; otherwise a subtotal, to be labelled as one and never shown under
   * a caption that says "Total".
   */
  @ApiProperty({ example: 60000.0 })
  knownIncome: number;

  @ApiProperty({ example: 42000.0 })
  knownExpenses: number;

  @ApiProperty({ example: 18000.0 })
  knownNet: number;
}

export class IncomeVsExpensesResponse {
  /**
   * Every bucket in the window, in order, including the ones nothing happened
   * in -- a week with no activity earned and spent zero, which is a bar of
   * height zero rather than a gap the chart closes up.
   */
  @ApiProperty({ type: [IncomeExpensePeriodItem] })
  data: IncomeExpensePeriodItem[];

  @ApiProperty({ type: IncomeExpenseTotals })
  totals: IncomeExpenseTotals;

  /** Reporting currency every figure above is expressed in. */
  @ApiProperty({ example: "CAD" })
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures above. Empty when the report is complete.
   */
  @ApiProperty({ type: [String], example: ["JPY"] })
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  @ApiProperty({ example: 0 })
  excludedCount: number;
}
