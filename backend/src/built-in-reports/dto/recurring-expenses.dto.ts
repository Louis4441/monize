import { ApiProperty } from "@nestjs/swagger";

export const RECURRING_EXPENSE_FREQUENCIES = [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "OCCASIONAL",
  "IRREGULAR",
] as const;

export type RecurringExpenseFrequency =
  (typeof RECURRING_EXPENSE_FREQUENCIES)[number];

/**
 * The look-back windows the analysis accepts, ending today. `all` has no lower
 * bound. The default, `6m`, is the window the report has always used.
 */
export const RECURRING_EXPENSE_RANGES = [
  "6m",
  "1y",
  "2y",
  "5y",
  "all",
] as const;

export type RecurringExpenseRange = (typeof RECURRING_EXPENSE_RANGES)[number];

export const DEFAULT_RECURRING_EXPENSE_RANGE: RecurringExpenseRange = "6m";

export function isRecurringExpenseRange(
  value: unknown,
): value is RecurringExpenseRange {
  return (
    typeof value === "string" &&
    (RECURRING_EXPENSE_RANGES as readonly string[]).includes(value)
  );
}

export class RecurringExpenseItem {
  @ApiProperty()
  payeeName: string;

  @ApiProperty({ nullable: true })
  payeeId: string | null;

  @ApiProperty()
  occurrences: number;

  @ApiProperty()
  totalAmount: number;

  @ApiProperty()
  averageAmount: number;

  @ApiProperty({ example: "2025-01-15" })
  lastTransactionDate: string;

  @ApiProperty({ enum: RECURRING_EXPENSE_FREQUENCIES })
  frequency: RecurringExpenseFrequency;

  @ApiProperty({ nullable: true })
  categoryName: string | null;
}

export class RecurringSummary {
  @ApiProperty()
  totalRecurring: number;

  @ApiProperty({
    description:
      "totalRecurring spread over the months the window covers (monthCount)",
  })
  monthlyEstimate: number;

  @ApiProperty({
    description:
      "Months the estimate is spread over: the preset's length, capped at the months of the user's spending history; for `all`, that history (at least 1)",
  })
  monthCount: number;

  @ApiProperty()
  uniquePayees: number;
}

export class RecurringExpensesResponse {
  @ApiProperty({ type: [RecurringExpenseItem] })
  data: RecurringExpenseItem[];

  @ApiProperty({ type: RecurringSummary })
  summary: RecurringSummary;
}
