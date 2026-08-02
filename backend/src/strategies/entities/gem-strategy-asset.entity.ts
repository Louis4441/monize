import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { User } from "../../users/entities/user.entity";
import { Security } from "../../securities/entities/security.entity";
import { GemStrategy } from "./gem-strategy.entity";

/** The roles a GEM strategy assigns an instrument to. */
export const GEM_ASSET_ROLES = [
  "US_EQUITY",
  "EX_US_EQUITY",
  "EM_EQUITY",
  "SAFE",
  "RISK_FREE",
] as const;

export type GemAssetRole = (typeof GEM_ASSET_ROLES)[number];

/** The equity roles -- the ones the relative-momentum step ranks. */
export const GEM_EQUITY_ROLES: readonly GemAssetRole[] = [
  "US_EQUITY",
  "EX_US_EQUITY",
  "EM_EQUITY",
];

/**
 * Roles the strategy runs without. `RISK_FREE` is the yardstick the absolute
 * test measures equities against -- Antonacci uses T-bills -- and it is separate
 * from `SAFE`, which is what the portfolio actually holds while RISK-OFF (an
 * aggregate bond fund in the original rules). Leaving it unassigned falls back
 * to `SAFE`, which is how the strategy behaved before the two were split, so an
 * existing configuration keeps producing the same signals.
 */
export const GEM_OPTIONAL_ROLES: readonly GemAssetRole[] = ["RISK_FREE"];

/**
 * The security filling one strategy role. `securityId` is nullable so a role
 * can exist unfilled: the report then reports that role as unmapped instead of
 * substituting an instrument the user never chose. A deleted security nulls the
 * reference (ON DELETE SET NULL) rather than dropping the role.
 */
@Entity("gem_strategy_assets")
@Unique(["strategyId", "role"])
export class GemStrategyAsset {
  @ApiProperty()
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty()
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @ApiProperty()
  @Column({ type: "uuid", name: "strategy_id" })
  strategyId: string;

  @ManyToOne(() => GemStrategy, (strategy) => strategy.assets, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "strategy_id" })
  strategy: GemStrategy;

  @ApiProperty({ enum: GEM_ASSET_ROLES })
  @Column({ type: "varchar", length: 20 })
  role: GemAssetRole;

  @ApiProperty({ required: false })
  @Column({ type: "uuid", name: "security_id", nullable: true })
  securityId: string | null;

  @ManyToOne(() => Security, { onDelete: "SET NULL" })
  @JoinColumn({ name: "security_id" })
  security: Security | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
