import { ApiProperty } from "@nestjs/swagger";
import { IsDateString, IsNumber, IsOptional, Min } from "class-validator";

export class PostScheduledInvestmentTransactionDto {
  @ApiProperty({
    required: false,
    description:
      "Override the transaction date for this single occurrence (YYYY-MM-DD). Defaults to the scheduled nextDueDate.",
  })
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  quantity?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  price?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  totalAmount?: number;
}
