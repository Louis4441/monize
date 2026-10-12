import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsOptional,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionDto } from "./create-transaction.dto";
import { CreateTransferDto } from "./create-transfer.dto";

/** The most rows one `POST /transactions/bulk` request may carry. */
export const BULK_CREATE_MAX_ITEMS = 500;

/**
 * One row of a bulk create: exactly one of `transaction` (the body
 * `POST /transactions` takes) or `transfer` (the body
 * `POST /transactions/transfer` takes). A row carrying neither fails
 * validation here; a row carrying both is refused as that row's result.
 */
export class BulkCreateItemDto {
  @ApiPropertyOptional({
    description: "A transaction, as POST /transactions takes it",
    type: CreateTransactionDto,
  })
  @ValidateIf((o: BulkCreateItemDto) => o.transfer == null)
  @IsDefined()
  @ValidateNested()
  @Type(() => CreateTransactionDto)
  transaction?: CreateTransactionDto;

  @ApiPropertyOptional({
    description: "A transfer, as POST /transactions/transfer takes it",
    type: CreateTransferDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateTransferDto)
  transfer?: CreateTransferDto;
}

export class BulkCreateTransactionsDto {
  @ApiProperty({
    description: `The rows to create, in order (1 to ${BULK_CREATE_MAX_ITEMS}). Each row is created on its own: one that fails does not undo the others, and the response reports every row by its index.`,
    type: [BulkCreateItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_CREATE_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BulkCreateItemDto)
  items: BulkCreateItemDto[];
}
