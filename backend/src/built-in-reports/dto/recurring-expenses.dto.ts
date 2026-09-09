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

  @ApiProperty()
  monthlyEstimate: number;

  @ApiProperty()
  uniquePayees: number;
}

export class RecurringExpensesResponse {
  @ApiProperty({ type: [RecurringExpenseItem] })
  data: RecurringExpenseItem[];

  @ApiProperty({ type: RecurringSummary })
  summary: RecurringSummary;
}
