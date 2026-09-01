import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Notification } from "./entities/notification.entity";
import { NotificationService } from "./notification.service";
import { NotificationController } from "./notification.controller";
import { BudgetsModule } from "../budgets/budgets.module";

/**
 * The notification centre: the durable `notifications` table, the one door that
 * writes it, and the endpoints an account reads it through.
 *
 * Not to be confused with `NotificationsModule` (`src/notifications/`), which is
 * the delivery side -- SMTP, the email templates, the provider-outage watcher. A
 * business feature asks this module for a notification and never imports a
 * transport; see `backend/CLAUDE.md`.
 *
 * The edge to `BudgetsModule` is deferred in both directions: budgets writes
 * through `NotificationService`, and the list endpoint asks budgets to
 * materialize any pending bill reminder first.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),
    forwardRef(() => BudgetsModule),
  ],
  providers: [NotificationService],
  controllers: [NotificationController],
  exports: [NotificationService],
})
export class NotificationCenterModule {}
