import { PartialType } from "@nestjs/swagger";
import { CreateScheduledInvestmentTransactionDto } from "./create-scheduled-investment-transaction.dto";

export class UpdateScheduledInvestmentTransactionDto extends PartialType(
  CreateScheduledInvestmentTransactionDto,
) {}
