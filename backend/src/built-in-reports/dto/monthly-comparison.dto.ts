import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { PeriodResultReason } from "../../net-worth/portfolio-period-result.util";

export class CategorySpendingComparisonItem {
  @ApiPropertyOptional()
  categoryId: string | null;

  @ApiProperty()
  categoryName: string;

  @ApiPropertyOptional()
  color: string | null;

  @ApiProperty()
  currentTotal: number;

  @ApiProperty()
  previousTotal: number;

  @ApiProperty()
  change: number;

  @ApiProperty()
  changePercent: number;
}

export class MonthlyComparisonIncomeExpenses {
  @ApiProperty()
  currentMonth: string;

  @ApiProperty()
  previousMonth: string;

  @ApiProperty()
  currentIncome: number;

  @ApiProperty()
  previousIncome: number;

  @ApiProperty()
  incomeChange: number;

  @ApiProperty()
  incomeChangePercent: number;

  @ApiProperty()
  currentExpenses: number;

  @ApiProperty()
  previousExpenses: number;

  @ApiProperty()
  expensesChange: number;

  @ApiProperty()
  expensesChangePercent: number;

  @ApiProperty()
  currentSavings: number;

  @ApiProperty()
  previousSavings: number;

  @ApiProperty()
  savingsChange: number;

  @ApiProperty()
  savingsChangePercent: number;
}

export class MonthlyComparisonNotes {
  @ApiProperty()
  savingsNote: string;

  @ApiProperty()
  incomeNote: string;
}

export class CategorySpendingSnapshot {
  @ApiPropertyOptional()
  categoryId: string | null;

  @ApiProperty()
  categoryName: string;

  @ApiPropertyOptional()
  color: string | null;

  @ApiProperty()
  total: number;
}

export class MonthlyComparisonExpenses {
  @ApiProperty({ type: [CategorySpendingSnapshot] })
  currentMonth: CategorySpendingSnapshot[];

  @ApiProperty({ type: [CategorySpendingSnapshot] })
  previousMonth: CategorySpendingSnapshot[];

  @ApiProperty({ type: [CategorySpendingComparisonItem] })
  comparison: CategorySpendingComparisonItem[];

  @ApiProperty()
  currentTotal: number;

  @ApiProperty()
  previousTotal: number;
}

export class TopCategoriesComparison {
  @ApiProperty({ type: [CategorySpendingSnapshot] })
  currentMonth: CategorySpendingSnapshot[];

  @ApiProperty({ type: [CategorySpendingSnapshot] })
  previousMonth: CategorySpendingSnapshot[];
}

export class NetWorthMonthlyPoint {
  @ApiProperty()
  month: string;

  @ApiProperty()
  netWorth: number;
}

export class MonthlyComparisonNetWorth {
  @ApiProperty({ type: [NetWorthMonthlyPoint] })
  monthlyHistory: NetWorthMonthlyPoint[];

  @ApiProperty()
  currentNetWorth: number;

  @ApiProperty()
  previousNetWorth: number;

  @ApiProperty()
  netWorthChange: number;

  @ApiProperty()
  netWorthChangePercent: number;
}

export class InvestmentAccountPerformance {
  @ApiProperty()
  accountId: string;

  @ApiProperty()
  accountName: string;

  /** The securities' value at the end of the window, cash excluded; null when unknown. */
  @ApiPropertyOptional({ type: Number, nullable: true })
  currentValue: number | null;

  /** The securities' value at the start of the window, cash excluded; null when unknown. */
  @ApiPropertyOptional({ type: Number, nullable: true })
  startValue: number | null;

  /** What the investments earned over the window, net of buys and sales. */
  @ApiPropertyOptional({ type: Number, nullable: true })
  investmentPnl: number | null;

  /**
   * The invested part's time-weighted return over the trailing year to
   * `periodEnd`, in percent. Deposits, purchases and idle cash move nothing.
   * Null when withheld; `returnReasons` says why.
   */
  @ApiPropertyOptional({ type: Number, nullable: true })
  returnPercent: number | null;

  @ApiProperty({ type: [String] })
  returnReasons: PeriodResultReason[];

  @ApiProperty()
  periodStart: string;

  @ApiProperty()
  periodEnd: string;
}

export class InvestmentTopMover {
  @ApiProperty()
  securityId: string;

  @ApiProperty()
  symbol: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  currentPrice: number;

  @ApiProperty()
  previousPrice: number;

  @ApiProperty()
  change: number;

  @ApiProperty()
  changePercent: number;

  @ApiPropertyOptional()
  marketValue: number | null;
}

export class MonthlyComparisonInvestments {
  @ApiProperty({ type: [InvestmentAccountPerformance] })
  accountPerformance: InvestmentAccountPerformance[];

  @ApiProperty({ type: [InvestmentTopMover] })
  topMovers: InvestmentTopMover[];
}

export class MonthlyComparisonResponse {
  @ApiProperty()
  currentMonth: string;

  @ApiProperty()
  previousMonth: string;

  @ApiProperty()
  currentMonthLabel: string;

  @ApiProperty()
  previousMonthLabel: string;

  @ApiProperty()
  currency: string;

  @ApiProperty({ type: MonthlyComparisonIncomeExpenses })
  incomeExpenses: MonthlyComparisonIncomeExpenses;

  @ApiProperty({ type: MonthlyComparisonNotes })
  notes: MonthlyComparisonNotes;

  @ApiProperty({ type: MonthlyComparisonExpenses })
  expenses: MonthlyComparisonExpenses;

  @ApiProperty({ type: TopCategoriesComparison })
  topCategories: TopCategoriesComparison;

  @ApiProperty({ type: MonthlyComparisonNetWorth })
  netWorth: MonthlyComparisonNetWorth;

  @ApiProperty({ type: MonthlyComparisonInvestments })
  investments: MonthlyComparisonInvestments;
}
