import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduledInvestmentTransaction } from "./entities/scheduled-investment-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ScheduledInvestmentTransactionsService } from "./scheduled-investment-transactions.service";
import { ScheduledInvestmentTransactionsController } from "./scheduled-investment-transactions.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { SecuritiesModule } from "../securities/securities.module";
import { ActionHistoryModule } from "../action-history/action-history.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduledInvestmentTransaction, UserPreference]),
    forwardRef(() => AccountsModule),
    forwardRef(() => SecuritiesModule),
    ActionHistoryModule,
  ],
  controllers: [ScheduledInvestmentTransactionsController],
  providers: [ScheduledInvestmentTransactionsService],
  exports: [ScheduledInvestmentTransactionsService],
})
export class ScheduledInvestmentTransactionsModule {}
