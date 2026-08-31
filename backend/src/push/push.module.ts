import { Module } from "@nestjs/common";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { PushConfigService } from "./push-config.service";
import { PushSubscriptionService } from "./push-subscription.service";
import { WebPushSender } from "./web-push-sender.service";
import { PushController } from "./push.controller";
import { AdminNotificationsController } from "./admin-notifications.controller";

/**
 * The Web Push transport.
 *
 * A leaf on purpose: it depends on `DataSource`, `EncryptionModule` and
 * `I18nService` and nothing else, so the notification producers that will use it
 * (bills, budgets, backups) can reach it without any of the cycles that
 * `NotificationsModule` needs `forwardRef` for. `WebPushSender` is exported for
 * exactly that future -- a business feature asks the notification layer to
 * deliver something and never imports a transport itself.
 */
@Module({
  imports: [EncryptionModule],
  providers: [PushConfigService, PushSubscriptionService, WebPushSender],
  controllers: [PushController, AdminNotificationsController],
  exports: [PushConfigService, WebPushSender],
})
export class PushModule {}
