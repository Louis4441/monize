import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Matches, Max, Min } from "class-validator";

/**
 * The window an occurrence-aware surface asks for.
 *
 * `maxPerSchedule` bounds the payload rather than the horizon: a daily schedule
 * over a long window is what makes the response large, and the cap is applied
 * after ordering by due date, so the occurrences that are returned are always the
 * next ones.
 */
export class ScheduledOccurrencesQueryDto {
  @ApiProperty({
    example: "2026-11-30",
    description: "Inclusive last due date to expand occurrences through",
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "through must be a YYYY-MM-DD date",
  })
  through: string;

  @ApiPropertyOptional({
    example: 100,
    default: 100,
    description: "Maximum occurrences returned per schedule (by due date)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxPerSchedule?: number;
}
