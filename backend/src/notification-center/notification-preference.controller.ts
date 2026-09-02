import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Put,
  Request,
  UseGuards,
  BadRequestException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

import { tr } from "../i18n/translate";
import { NotificationCategory } from "./entities/notification.entity";
import {
  NotificationPreferenceService,
  NOTIFICATION_PREFERENCE_CATEGORIES,
} from "./notification-preference.service";
import { UpdateNotificationPreferenceDto } from "./dto/update-notification-preference.dto";

/**
 * The per-category channel matrix, from the account's own side. Personal
 * settings only: the `userId` comes from the JWT, never a param, and a category
 * outside the exposed matrix is refused rather than silently stored.
 */
@Controller("notifications/preferences")
@UseGuards(AuthGuard("jwt"))
export class NotificationPreferenceController {
  constructor(private readonly preferences: NotificationPreferenceService) {}

  @Get()
  list(@Request() req: { user: { id: string } }) {
    return this.preferences.list(req.user.id);
  }

  @Put(":category")
  update(
    @Request() req: { user: { id: string } },
    @Param("category", new ParseEnumPipe(NotificationCategory))
    category: NotificationCategory,
    @Body() dto: UpdateNotificationPreferenceDto,
  ) {
    if (!NOTIFICATION_PREFERENCE_CATEGORIES.includes(category)) {
      // A real NotificationCategory the matrix does not expose yet (SYSTEM):
      // storing it would be a preference nothing reads.
      throw new BadRequestException(
        tr(
          "errors.notifications.categoryNotConfigurable",
          `Category ${category} is not configurable here`,
          { category },
        ),
      );
    }
    // Every field is optional so channels move independently, but an empty body
    // is a request that asks for nothing -- reject it rather than write a
    // default-valued row for a category the user never configured.
    if (
      dto.email === undefined &&
      dto.emailNotification === undefined &&
      dto.push === undefined &&
      dto.throttleMinutes === undefined
    ) {
      throw new BadRequestException(
        tr(
          "errors.notifications.emptyPreferenceUpdate",
          "At least one preference field is required",
        ),
      );
    }
    return this.preferences.updatePreference(req.user.id, category, {
      email: dto.email,
      emailNotification: dto.emailNotification,
      push: dto.push,
      throttleMinutes: dto.throttleMinutes,
    });
  }
}
