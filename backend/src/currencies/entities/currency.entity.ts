import { Entity, PrimaryColumn, Column, CreateDateColumn } from "typeorm";
import { ApiProperty } from "@nestjs/swagger";

@Entity("currencies")
export class Currency {
  @ApiProperty({ example: "CAD" })
  @PrimaryColumn({ type: "varchar", length: 3 })
  code: string;

  @ApiProperty({ example: "Canadian Dollar" })
  @Column({ type: "varchar", length: 100 })
  name: string;

  @ApiProperty({ example: "$" })
  @Column({ type: "varchar", length: 10 })
  symbol: string;

  @ApiProperty({ example: 2 })
  @Column({ type: "smallint", name: "decimal_places", default: 2 })
  decimalPlaces: number;

  @ApiProperty({ example: true })
  @Column({ type: "boolean", name: "is_active", default: true })
  isActive: boolean;

  @Column({ type: "uuid", name: "created_by_user_id", nullable: true })
  createdByUserId: string | null;

  /**
   * The latest date a rate provider was found to have no rate for this
   * currency, against `providerMissingAgainst`.
   *
   * A provider's history starts where it starts, and nothing the reader does
   * moves it: Yahoo carries no USD/CAD before December 2003. Without this the
   * gap fill re-learns that at one provider call per dead year, after every
   * restart. `YYYY-MM-DD` through the raw read that uses it, never the DATE
   * parser.
   */
  @ApiProperty({ required: false, example: "2003-08-31" })
  @Column({ type: "date", name: "provider_missing_through", nullable: true })
  providerMissingThrough: string | null;

  /**
   * The other side of the pair `providerMissingThrough` was established
   * against, because the floor belongs to the pair and not to this currency:
   * Yahoo's history for USD/CAD and for USD/PLN begins on different days. The
   * hint is honoured only for a reader whose reporting currency is this code.
   */
  @ApiProperty({ required: false, example: "CAD" })
  @Column({
    type: "varchar",
    length: 3,
    name: "provider_missing_against",
    nullable: true,
  })
  providerMissingAgainst: string | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
