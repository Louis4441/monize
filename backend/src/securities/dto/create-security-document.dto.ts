import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { SecurityDocumentType } from "../entities/security-document.entity";

export class CreateSecurityDocumentDto {
  @ApiPropertyOptional({
    enum: SecurityDocumentType,
    default: SecurityDocumentType.OTHER,
  })
  @IsOptional()
  @IsEnum(SecurityDocumentType)
  documentType?: SecurityDocumentType;

  @ApiProperty({ example: "2024 Annual Report" })
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({
    example: "2024-12-31",
    description: "The date on the document, not the day it was recorded.",
  })
  @IsOptional()
  @IsISO8601()
  documentDate?: string;

  @ApiProperty({
    example: "https://www.ishares.com/factsheet.pdf",
    description:
      "Where the document lives. Must be an http(s) address: the UI renders this as a link, and any other scheme would make that link a way to run something.",
  })
  @IsString()
  @MaxLength(2048)
  // `protocols` is the security-relevant part, not a nicety: without it
  // `javascript:alert(1)` validates, and the Open action would then render an
  // anchor that executes it. `require_protocol` forces the scheme to be written
  // out, so there is nothing to infer and nothing to get wrong.
  @IsUrl({
    protocols: ["http", "https"],
    require_protocol: true,
    require_tld: true,
  })
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  notes?: string;
}
