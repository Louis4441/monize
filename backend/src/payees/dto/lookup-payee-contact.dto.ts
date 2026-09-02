import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

/** Body of `POST /payees/lookup-contact`: the name the form holds. */
export class LookupPayeeContactDto {
  @ApiProperty({ example: "Starbucks", description: "Name of the payee" })
  @IsString()
  @MinLength(1)
  // Mirrors CreatePayeeDto.name: a name the form could not save is not
  // worth looking up.
  @MaxLength(100)
  @SanitizeHtml()
  name: string;
}
