import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  GEM_ASSET_ROLES,
  GemAssetRole,
} from "../entities/gem-strategy-asset.entity";

const MAX_COMMISSION = 1_000_000;

/** A sane ceiling for how many accounts one strategy can span. */
const MAX_ACCOUNTS = 50;

export class GemStrategyAssetDto {
  @ApiPropertyOptional({ enum: GEM_ASSET_ROLES })
  @IsIn(GEM_ASSET_ROLES)
  role: GemAssetRole;

  @ApiPropertyOptional({
    nullable: true,
    description: "Security filling this role; null clears the assignment",
  })
  @IsOptional()
  @IsUUID()
  securityId?: string | null;
}

export class UpdateGemStrategyDto {
  @ApiPropertyOptional({
    description: "Scenario name shown in the report switcher",
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Brokerage accounts the strategy is run in; their holdings are summed. " +
      "Sending the field replaces the whole set, so an empty array clears it.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ACCOUNTS)
  @IsUUID(undefined, { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({ enum: ["MONTHLY", "QUARTERLY"] })
  @IsOptional()
  @IsIn(["MONTHLY", "QUARTERLY"])
  cadence?: "MONTHLY" | "QUARTERLY";

  @ApiPropertyOptional({
    description: "Momentum lookback window in months",
    minimum: 1,
    maximum: 60,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  lookbackMonths?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: "Tax rate applied to an estimated realized gain, in percent",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRatePercent?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "Estimated broker commission per switch",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_COMMISSION)
  commissionAmount?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  // A blank field arrives as "" from the form, which @IsOptional does not
  // waive; without this, clearing the link would fail the whole save.
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(500)
  // Rendered into an anchor in the report footer, so the scheme is a security
  // control: `javascript:...` survives @SanitizeHtml and would become a
  // clickable way to run it. Same whitelist the other link fields carry.
  @IsUrl({
    protocols: ["http", "https"],
    require_protocol: false,
    require_tld: true,
  })
  @SanitizeHtml()
  rulesSourceUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  rulesSourceLabel?: string | null;

  @ApiPropertyOptional({
    type: [GemStrategyAssetDto],
    description: "Role assignments to create or update",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(GEM_ASSET_ROLES.length)
  @ValidateNested({ each: true })
  @Type(() => GemStrategyAssetDto)
  assets?: GemStrategyAssetDto[];
}
