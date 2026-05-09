import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { Account } from "../../accounts/entities/account.entity";
import { Security } from "../../securities/entities/security.entity";
import { User } from "../../users/entities/user.entity";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import type { FrequencyType } from "../../common/recurrence";

const dateStringTransformer = {
  from: (value: string | Date | null): string | null => {
    if (value === null || value === undefined) return value as null;
    if (typeof value === "string") return value;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

const numericTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

@Entity("scheduled_investment_transactions")
export class ScheduledInvestmentTransaction {
  @ApiProperty()
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @ApiProperty()
  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: "account_id" })
  account: Account;

  @ApiProperty({ required: false })
  @Column({ type: "uuid", name: "funding_account_id", nullable: true })
  fundingAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "funding_account_id" })
  fundingAccount: Account | null;

  @ApiProperty({ required: false })
  @Column({ type: "uuid", name: "security_id", nullable: true })
  securityId: string | null;

  @ManyToOne(() => Security, { nullable: true })
  @JoinColumn({ name: "security_id" })
  security: Security | null;

  @ApiProperty({ enum: InvestmentAction })
  @Column({ type: "varchar", length: 50 })
  action: InvestmentAction;

  @ApiProperty()
  @Column({ type: "varchar", length: 255 })
  name: string;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 8,
    nullable: true,
    transformer: numericTransformer,
  })
  quantity: number | null;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 6,
    nullable: true,
    transformer: numericTransformer,
  })
  price: number | null;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    default: 0,
    transformer: {
      to: (v: number | null | undefined): number =>
        v === null || v === undefined ? 0 : v,
      from: (v: string | null): number => (v === null ? 0 : Number(v)),
    },
  })
  commission: number;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "total_amount",
    nullable: true,
    transformer: numericTransformer,
  })
  totalAmount: number | null;

  @ApiProperty({ required: false })
  @Column({
    type: "varchar",
    name: "currency_code",
    length: 3,
    nullable: true,
  })
  currencyCode: string | null;

  @ApiProperty({ required: false })
  @Column({
    type: "decimal",
    precision: 20,
    scale: 10,
    name: "exchange_rate",
    nullable: true,
    transformer: numericTransformer,
  })
  exchangeRate: number | null;

  @ApiProperty({ required: false })
  @Column({ type: "text", nullable: true })
  description: string | null;

  @ApiProperty()
  @Column({ type: "varchar", length: 20 })
  frequency: FrequencyType;

  @ApiProperty()
  @Column({
    type: "date",
    name: "next_due_date",
    transformer: dateStringTransformer,
  })
  nextDueDate: string;

  @ApiProperty({ required: false })
  @Column({
    type: "date",
    name: "start_date",
    nullable: true,
    transformer: dateStringTransformer,
  })
  startDate: string | null;

  @ApiProperty({ required: false })
  @Column({
    type: "date",
    name: "end_date",
    nullable: true,
    transformer: dateStringTransformer,
  })
  endDate: string | null;

  @ApiProperty({ required: false })
  @Column({ type: "int", name: "occurrences_remaining", nullable: true })
  occurrencesRemaining: number | null;

  @ApiProperty({ required: false })
  @Column({ type: "int", name: "total_occurrences", nullable: true })
  totalOccurrences: number | null;

  @ApiProperty()
  @Column({ name: "is_active", default: true })
  isActive: boolean;

  @ApiProperty()
  @Column({ name: "auto_post", default: false })
  autoPost: boolean;

  @ApiProperty()
  @Column({ type: "int", name: "reminder_days_before", default: 3 })
  reminderDaysBefore: number;

  @ApiProperty({ required: false })
  @Column({
    type: "date",
    name: "last_posted_date",
    nullable: true,
    transformer: dateStringTransformer,
  })
  lastPostedDate: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
