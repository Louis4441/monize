import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";

/**
 * A daily close for one curated market index.
 *
 * Global reference data: no `userId`, no relation to `securities`, and no RLS
 * policy -- the same S&P 500 close serves every user in the deployment, exactly
 * as an exchange rate does. See the exemption note at the foot of
 * `database/schema.sql`.
 */
@Entity("market_index_prices")
@Unique(["indexCode", "priceDate"])
export class MarketIndexPrice {
  @ApiProperty()
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id: number;

  /**
   * The app's own stable key for the index (`SP500`, `FTSE100`, ...), defined in
   * `market-indexes.ts`. Not the provider's symbol: `^GSPC` is a Yahoo spelling,
   * and keying on it would make a provider change a data migration.
   */
  @ApiProperty()
  @Column({ type: "varchar", length: 32, name: "index_code" })
  indexCode: string;

  @ApiProperty()
  @Column({
    type: "date",
    name: "price_date",
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      },
      to: (value: string | Date): string | Date => value,
    },
  })
  priceDate: string;

  @ApiProperty()
  @Column({ type: "decimal", precision: 24, scale: 10, name: "close_price" })
  closePrice: number;

  /**
   * Split- and distribution-adjusted close where the provider supplies one.
   * Nullable per row for the same reason it is on `security_prices`, and read
   * the same way: the basis is chosen once per series, never per row
   * (`docs/time-series-contract.md` rule 1).
   */
  @ApiProperty({ required: false, nullable: true })
  @Column({
    type: "decimal",
    precision: 24,
    scale: 10,
    name: "adjusted_close",
    nullable: true,
  })
  adjustedClose: number | null;

  @ApiProperty()
  @Column({ type: "varchar", length: 50 })
  source: string;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
