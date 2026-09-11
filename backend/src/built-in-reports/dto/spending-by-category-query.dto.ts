import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from "class-validator";
import { ReportQueryDto } from "./report-query.dto";

/** A comma-separated query parameter, as a trimmed non-empty array. */
function csv({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Spending by Category is the one answer the full report and the dashboard
 * widget both draw, so the two settings the widget carried on the client --
 * which accounts, and whether subcategories roll up -- are asked of the server
 * instead of re-derived beside it.
 */
export class SpendingByCategoryQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    description: "Account ids to restrict the report to (comma-separated)",
    type: [String],
  })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  // Bounded because an unbounded array is a lever on the query planner, and
  // `common/array-bound-dto.spec.ts` fails a new one without a cap. No user has
  // more accounts than this to pick from in one filter.
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({
    description:
      "Count a subcategory's spend against its top-level ancestor. Defaults to true.",
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true" || value === true)
  rollupToParent?: boolean;
}
