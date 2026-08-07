import { Entity, Column, PrimaryColumn } from "typeorm";
import { ApiProperty } from "@nestjs/swagger";

/**
 * When each index was last fetched, successfully or not.
 *
 * Without it, an index the provider cannot serve is re-requested on every chart
 * render: the price table stays empty, so "do we have history back to the window
 * start" is false every time and the on-demand backfill fires again.
 * `securities.historicalBackfillAttemptedAt` exists for the same reason.
 *
 * The three fields are deliberately distinct. `lastAttemptAt` drives the
 * cooldown and advances whether or not the fetch worked; `lastSuccessAt` says
 * whether the index has ever been served at all; `lastError` is what an operator
 * reads when it has not.
 */
@Entity("market_index_sync")
export class MarketIndexSync {
  @ApiProperty()
  @PrimaryColumn({ type: "varchar", length: 32, name: "index_code" })
  indexCode: string;

  @ApiProperty({ required: false, nullable: true })
  @Column({ type: "timestamptz", name: "last_attempt_at", nullable: true })
  lastAttemptAt: Date | null;

  @ApiProperty({ required: false, nullable: true })
  @Column({ type: "timestamptz", name: "last_success_at", nullable: true })
  lastSuccessAt: Date | null;

  @ApiProperty({ required: false, nullable: true })
  @Column({ type: "text", name: "last_error", nullable: true })
  lastError: string | null;
}
