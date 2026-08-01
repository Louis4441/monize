import { IsOptional, IsString, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateGemStrategyDto {
  @ApiPropertyOptional({
    description:
      "Scenario name shown in the report switcher. Blank gets a default.",
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name?: string;
}
