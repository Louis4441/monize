import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { ReportQueryDto } from "./report-query.dto";

/** Surrounding whitespace is a paste artifact, never part of a tag key. */
const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/**
 * Cash Flow answers through the same `IncomeReportsService.getIncomeVsExpenses`
 * query as Income vs Expenses (`built-in-reports.controller.ts`), so it takes
 * the same optional tag-key breakdown (`docs/specs/report-tag-key-breakdown.md`).
 * The other Income vs Expenses knobs (`accountIds`, `bucket`, `weekStartsOn`)
 * are out of scope for this route, as they were before this change.
 */
export class CashFlowQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    description:
      "Bare KEY of a KEY:VALUE tag to break the report down by (e.g. 'scope'). Absent renders today's response unchanged.",
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(100)
  tagKey?: string;
}
