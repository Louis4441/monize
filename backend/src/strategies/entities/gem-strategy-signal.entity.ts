import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { User } from "../../users/entities/user.entity";
import { Security } from "../../securities/entities/security.entity";
import { GemStrategy } from "./gem-strategy.entity";
import { GemAssetRole } from "./gem-strategy-asset.entity";

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

const dateTransformer = {
  from: (value: string | Date): string => {
    if (!value) return value as string;
    if (typeof value === "string") return value;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  },
  to: (value: string | Date): string | Date => value,
};

/** Absolute-momentum outcome: equities in, or the safe asset. */
export type GemSignalState = "RISK_ON" | "RISK_OFF";

/** Trailing momentum per role at evaluation time, in percent. */
export type GemMomentumSnapshot = Partial<Record<GemAssetRole, number | null>>;

/**
 * One evaluated GEM period. The momentum figures the decision was taken on are
 * stored with the outcome, so the history keeps what was actually decided even
 * if prices are later revised or an instrument is re-assigned -- and so the
 * user's "executed" flag has a stable row to hang on.
 *
 * One row per (strategy, evaluation date, algorithm version); re-evaluating an
 * already stored period is a no-op rather than an update. The version is in the
 * key so a row an older release wrote -- a record of a real decision, and of
 * the user's execution of it -- neither gets rewritten nor blocks the current
 * release from evaluating the same period.
 */
@Entity("gem_strategy_signals")
@Unique(["strategyId", "evaluatedOn", "algorithmVersion"])
export class GemStrategySignal {
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

  @ManyToOne(() => GemStrategy, { onDelete: "CASCADE" })
  @JoinColumn({ name: "strategy_id" })
  strategy: GemStrategy;

  @ApiProperty({ description: "Price date the decision was taken on" })
  @Column({
    type: "date",
    name: "evaluated_on",
    transformer: dateTransformer,
  })
  evaluatedOn: string;

  @ApiProperty({ description: "First day the resulting allocation applies" })
  @Column({
    type: "date",
    name: "effective_from",
    transformer: dateTransformer,
  })
  effectiveFrom: string;

  @ApiProperty({ enum: ["RISK_ON", "RISK_OFF"] })
  @Column({ type: "varchar", length: 10 })
  state: GemSignalState;

  @ApiProperty({ required: false })
  @Column({ type: "varchar", length: 20, name: "target_role", nullable: true })
  targetRole: GemAssetRole | null;

  @ApiProperty({ required: false })
  @Column({ type: "uuid", name: "target_security_id", nullable: true })
  targetSecurityId: string | null;

  @ManyToOne(() => Security, { onDelete: "SET NULL" })
  @JoinColumn({ name: "target_security_id" })
  targetSecurity: Security | null;

  @ApiProperty()
  @Column({
    type: "decimal",
    precision: 9,
    scale: 4,
    name: "target_weight_percent",
    default: 100,
    transformer: numericTransformer,
  })
  targetWeightPercent: number;

  @ApiProperty({ description: "Momentum per role at evaluation time, percent" })
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  momentum: GemMomentumSnapshot;

  @ApiProperty({
    required: false,
    description: "Role the absolute test measured equities against",
  })
  @Column({
    type: "varchar",
    length: 20,
    name: "benchmark_role",
    nullable: true,
  })
  benchmarkRole: GemAssetRole | null;

  @ApiProperty({
    required: false,
    description: "US equity momentum minus benchmark momentum, in pp",
  })
  @Column({
    type: "decimal",
    precision: 12,
    scale: 4,
    name: "spread_pp",
    nullable: true,
    transformer: numericTransformer,
  })
  spreadPp: number | null;

  @ApiProperty({
    required: false,
    description: "Winner minus runner-up, in pp (RISK_ON only)",
  })
  @Column({
    type: "decimal",
    precision: 12,
    scale: 4,
    name: "lead_pp",
    nullable: true,
    transformer: numericTransformer,
  })
  leadPp: number | null;

  @ApiProperty({ required: false, description: "Role held before this period" })
  @Column({
    type: "varchar",
    length: 20,
    name: "previous_role",
    nullable: true,
  })
  previousRole: GemAssetRole | null;

  @ApiProperty({
    required: false,
    description:
      "Hash of the configuration this signal was calculated under; NULL for rows predating the column",
  })
  @Column({
    type: "varchar",
    length: 64,
    name: "config_fingerprint",
    nullable: true,
  })
  configFingerprint: string | null;

  /**
   * Version of the evaluation code that produced this row.
   *
   * Kept apart from `configFingerprint` because the two mean different things
   * and are handled differently. A fingerprint mismatch is the user having
   * changed the settings, so the period is recomputed in place -- they asked
   * for a different answer. A version mismatch is not: this row is the record
   * of what the strategy decided and what the user executed against it, and
   * recomputing it with today's code and today's (possibly revised) prices
   * would put a counterfactual in its place. Older versions are legacy
   * periods: untouched, and left out of the current history and backtest.
   */
  @ApiProperty()
  @Column({ type: "smallint", name: "algorithm_version", default: 1 })
  algorithmVersion: number;

  @ApiProperty()
  @Column({ type: "boolean", default: false })
  executed: boolean;

  @ApiProperty({ required: false })
  @Column({ type: "timestamp", name: "executed_at", nullable: true })
  executedAt: Date | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
