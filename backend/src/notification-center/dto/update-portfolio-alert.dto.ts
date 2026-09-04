import { ApiProperty } from "@nestjs/swagger";
import { IsNumber, Max, Min, ValidateIf } from "class-validator";

/**
 * Set (or clear) the daily portfolio-movement threshold, in percent. `null`
 * turns the alert off; a positive number is the crossing threshold
 * (`docs/specs/portfolio-movement-notifications.md`).
 */
export class UpdatePortfolioAlertDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Threshold in percent, or null to turn the alert off.",
  })
  // `null` is the off state and is validated as such (skipped); a supplied value
  // must be a bounded positive number. Absent is rejected -- the field is
  // required, so the caller states on or off explicitly.
  @ValidateIf((_o, value) => value !== null)
  @IsNumber()
  @Min(0.1)
  @Max(1000)
  movePercent!: number | null;
}
