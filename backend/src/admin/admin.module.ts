import { Module } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AdminController } from "./admin.controller";
import { OAuthModule } from "../oauth/oauth.module";
import { UsersModule } from "../users/users.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [OAuthModule, UsersModule, NotificationsModule],
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
