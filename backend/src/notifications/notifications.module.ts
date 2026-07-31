import { Module } from "@nestjs/common";
import { EmailService } from "./email.service";
import { BillReminderService } from "./bill-reminder.service";
import { NotificationsController } from "./notifications.controller";
import { UsersModule } from "../users/users.module";

@Module({
  imports: [UsersModule],
  providers: [EmailService, BillReminderService],
  controllers: [NotificationsController],
  exports: [EmailService],
})
export class NotificationsModule {}
