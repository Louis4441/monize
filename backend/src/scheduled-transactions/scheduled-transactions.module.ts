import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { Account } from "../accounts/entities/account.entity";
import { Tag } from "../tags/entities/tag.entity";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { ScheduledEffectiveAmountService } from "./scheduled-effective-amount.service";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ScheduledTransactionsController } from "./scheduled-transactions.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { SecuritiesModule } from "../securities/securities.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { DelegationModule } from "../delegation/delegation.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScheduledTransaction,
      ScheduledTransactionSplit,
      ScheduledTransactionOverride,
      Account,
      Tag,
    ]),
    forwardRef(() => AccountsModule),
    TransactionsModule,
    forwardRef(() => SecuritiesModule),
    forwardRef(() => CurrenciesModule),
    ActionHistoryModule,
    DelegationModule,
  ],
  providers: [
    ScheduledTransactionsService,
    ScheduledEffectiveAmountService,
    ScheduledTransactionOverrideService,
    ScheduledTransactionLoanService,
  ],
  controllers: [ScheduledTransactionsController],
  // The effective-amount resolver is exported so a consumer that reads schedule
  // rows for itself (BudgetsService) asks it rather than re-deriving the #1167
  // FX rules (issue #1247).
  exports: [ScheduledTransactionsService, ScheduledEffectiveAmountService],
})
export class ScheduledTransactionsModule {}
