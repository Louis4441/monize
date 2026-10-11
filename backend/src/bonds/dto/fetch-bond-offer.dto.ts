import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches } from "class-validator";

/**
 * A request to fetch every series of a country's current offer that the catalog
 * lacks: only a country. The terms come from the official source, never from the
 * caller (INV-BOND-006).
 */
export class FetchBondOfferDto {
  @ApiProperty({ example: "PL", description: "Two-letter country code" })
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: "countryCode must be two upper-case letters",
  })
  countryCode: string;
}
