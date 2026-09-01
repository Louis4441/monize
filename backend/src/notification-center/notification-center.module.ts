import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Notification } from "./entities/notification.entity";
import { NotificationService } from "./notification.service";

/**
 * The durable `notifications` table and the one service that reads and writes
 * it. Deliberately depends on nothing but the connection.
 *
 * That is what keeps it out of every require cycle in the graph: budgets,
 * system alerts, backups and scheduled transactions all produce notifications,
 * so anything this module imported would become reachable from all of them. The
 * HTTP surface, which does need a producer (bill reminders are materialized on
 * read), is a separate module for the same reason -- see
 * `notification-api.module.ts`.
 *
 * Not to be confused with `NotificationsModule` (`src/notifications/`), which is
 * the delivery side -- SMTP, the email templates, the provider-outage watcher. A
 * business feature asks this module for a notification and never imports a
 * transport; see `backend/CLAUDE.md`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationCenterModule {}
