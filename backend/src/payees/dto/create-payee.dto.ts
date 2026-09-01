import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  MaxLength,
  IsUUID,
  IsUrl,
  IsEmail,
  ValidateIf,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreatePayeeDto {
  @ApiProperty({ example: "Starbucks", description: "Name of the payee" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiProperty({
    example: "category-uuid",
    required: false,
    description: "Default category ID for transactions with this payee",
  })
  @IsOptional()
  @ValidateIf((o) => o.defaultCategoryId !== null)
  @IsUUID()
  defaultCategoryId?: string | null;

  @ApiProperty({
    example: "Local coffee shop on Main Street",
    required: false,
    description: "Notes about the payee",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  notes?: string;

  @ApiProperty({
    example: "https://www.starbucks.com",
    required: false,
    description:
      "The payee's website. Stored absolute; https is added when no scheme is given.",
  })
  @IsOptional()
  // An optional field cleared in the form arrives as "", and `@IsOptional`
  // only waives validation for undefined and null -- so without this the URL
  // check runs on the empty string, rejects it, and every save from a form that
  // leaves the address blank returns 400. The service reads "" as "clear it".
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(2048)
  // Rendered as a link on the detail page, so the scheme is a security control:
  // without the protocol whitelist `javascript:...` validates and the anchor
  // becomes a way to run it. `require_protocol: false` keeps typing
  // "starbucks.com" working -- the service normalises it before storing.
  @IsUrl({
    protocols: ["http", "https"],
    require_protocol: false,
    require_tld: true,
  })
  website?: string | null;

  @ApiProperty({
    example: "1912 Pike Pl, Seattle, WA 98101",
    required: false,
    description:
      "Free-text postal address, rendered as a link that opens the reader's maps app.",
  })
  @IsOptional()
  // Same "" -> clear contract as `website` above: the form sends an empty
  // string for a field the user emptied, and the service reads it as a clear.
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  address?: string | null;

  @ApiProperty({
    example: "hello@starbucks.com",
    required: false,
    description: "Contact email, rendered as a mailto link.",
  })
  @IsOptional()
  // `@IsOptional` waives undefined and null but not "", and the form sends ""
  // to clear -- without this every save with a blank email would 400.
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @ApiProperty({
    example: "+1 206-448-8762",
    required: false,
    description: "Contact phone number, rendered as a tel link.",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  // Length cap only: international numbers carry country codes, spaces,
  // parentheses and extensions, so a format check would reject valid numbers.
  // The value is only ever displayed and turned into a tel: href.
  @MaxLength(50)
  @SanitizeHtml()
  phone?: string | null;
}
