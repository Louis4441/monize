import { Module, forwardRef } from "@nestjs/common";
import { EmailService } from "./email.service";
import { BillReminderService } from "./bill-reminder.service";
import { ProviderOutageAlertService } from "./provider-outage-alert.service";
import { NotificationsController } from "./notifications.controller";
import { UsersModule } from "../users/users.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module";

@Module({
  imports: [
    UsersModule,
    // For ScheduledEffectiveAmountService: a bill reminder quotes the amount the
    // posting will use, not the persisted snapshot (issue #1247). `forwardRef`
    // because that module reaches AccountsModule and DelegationModule, both of
    // which import this one -- see `src/module-graph.spec.ts`.
    forwardRef(() => ScheduledTransactionsModule),
    // For SystemAlertService: ProviderOutageAlertService raises the in-app
    // companion rows beside its emails. `forwardRef` because SystemAlertsModule
    // imports this module back for EmailService.
    forwardRef(() => SystemAlertsModule),
  ],
  providers: [EmailService, BillReminderService, ProviderOutageAlertService],
  controllers: [NotificationsController],
  exports: [EmailService],
})
export class NotificationsModule {}
