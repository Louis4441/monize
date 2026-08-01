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
import { Account } from "../../accounts/entities/account.entity";
import { GemStrategy } from "./gem-strategy.entity";

/**
 * A brokerage account the strategy is run in. The GEM signal depends only on
 * prices, so it is identical for every account; what differs is the holdings it
 * is compared against, which the report sums across the whole set.
 */
@Entity("gem_strategy_accounts")
@Unique(["strategyId", "accountId"])
export class GemStrategyAccount {
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

  @ManyToOne(() => GemStrategy, (strategy) => strategy.accounts, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "strategy_id" })
  strategy: GemStrategy;

  @ApiProperty()
  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account: Account;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
