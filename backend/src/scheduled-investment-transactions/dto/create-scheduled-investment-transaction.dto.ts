import { ApiProperty } from "@nestjs/swagger";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export const FREQUENCY_VALUES = [
  "ONCE",
  "DAILY",
  "WEEKLY",
  "BIWEEKLY",
  "EVERY4WEEKS",
  "SEMIMONTHLY",
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
] as const;

export type FrequencyValue = (typeof FREQUENCY_VALUES)[number];

export class CreateScheduledInvestmentTransactionDto {
  @ApiProperty()
  @IsUUID()
  accountId: string;

  @ApiProperty({
    required: false,
    description: "Cash source account when different from the brokerage cash",
  })
  @IsOptional()
  @IsUUID()
  fundingAccountId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiProperty({ enum: InvestmentAction })
  @IsEnum(InvestmentAction)
  action: InvestmentAction;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

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

  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  commission?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  totalAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currencyCode?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  exchangeRate?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;

  @ApiProperty({ enum: FREQUENCY_VALUES })
  @IsEnum(FREQUENCY_VALUES)
  frequency: FrequencyValue;

  @ApiProperty({ description: "YYYY-MM-DD" })
  @IsDateString()
  nextDueDate: string;

  @ApiProperty({ required: false, description: "YYYY-MM-DD" })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, description: "YYYY-MM-DD" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  occurrencesRemaining?: number;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  autoPost?: boolean;

  @ApiProperty({ required: false, default: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  reminderDaysBefore?: number;
}
