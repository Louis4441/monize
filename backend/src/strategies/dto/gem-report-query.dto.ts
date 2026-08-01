import { IsIn, IsOptional, IsUUID } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { GEM_RANGES, GemRange } from "../gem-report.types";

export class GemReportQueryDto {
  @ApiPropertyOptional({
    enum: GEM_RANGES,
    default: "1Y",
    description: "Window for the asset-performance series",
  })
  @IsOptional()
  @IsIn(GEM_RANGES)
  range?: GemRange;

  @ApiPropertyOptional({
    description:
      "Scenario to report on. Omitted, the user's first scenario is used.",
  })
  @IsOptional()
  @IsUUID()
  strategyId?: string;
}
