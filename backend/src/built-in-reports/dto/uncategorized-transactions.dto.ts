import { ApiProperty } from "@nestjs/swagger";

export class UncategorizedTransactionItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  transactionDate: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  currencyCode: string;

  @ApiProperty({ nullable: true })
  payeeName: string | null;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  accountName: string | null;

  @ApiProperty()
  accountId: string;
}

export class UncategorizedTransactionsSummary {
  @ApiProperty()
  totalCount: number;

  @ApiProperty()
  expenseCount: number;

  @ApiProperty()
  expenseTotal: number;

  @ApiProperty()
  incomeCount: number;

  @ApiProperty()
  incomeTotal: number;

  @ApiProperty()
  currencyCode: string;
}

export class UncategorizedTransactionsResponse {
  @ApiProperty({ type: [UncategorizedTransactionItem] })
  transactions: UncategorizedTransactionItem[];

  @ApiProperty({ type: UncategorizedTransactionsSummary })
  summary: UncategorizedTransactionsSummary;
}
