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
  configurableCategoriesFor,
  NotificationPreferenceService,
} from "./notification-preference.service";
import { UpdateNotificationPreferenceDto } from "./dto/update-notification-preference.dto";

/**
 * The per-category channel matrix, from the account's own side. Personal
 * settings only: the `userId` comes from the JWT, never a param, and a category
 * outside the exposed matrix is refused rather than silently stored.
 */
interface AuthenticatedRequest {
  user: { id: string; role?: string };
}

/** The role is the JWT's (`req.user.role`), never a request field. */
function categoriesFor(req: AuthenticatedRequest) {
  return configurableCategoriesFor(req.user.role === "admin");
}

@Controller("notifications/preferences")
@UseGuards(AuthGuard("jwt"))
export class NotificationPreferenceController {
  constructor(private readonly preferences: NotificationPreferenceService) {}

  @Get()
  list(@Request() req: AuthenticatedRequest) {
    return this.preferences.list(req.user.id, categoriesFor(req));
  }

  @Put(":category")
  update(
    @Request() req: AuthenticatedRequest,
    @Param("category", new ParseEnumPipe(NotificationCategory))
    category: NotificationCategory,
    @Body() dto: UpdateNotificationPreferenceDto,
  ) {
    if (!categoriesFor(req).includes(category)) {
      // Either a real NotificationCategory the matrix does not expose (a future
      // enum member not yet wired into the matrix) or SYSTEM for a non-admin,
      // whose alerts are never raised: storing it would be a preference nothing
      // reads, and a cell the caller's own matrix does not show.
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
      dto.unifiedpush === undefined &&
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
      unifiedpush: dto.unifiedpush,
      throttleMinutes: dto.throttleMinutes,
    });
  }
}
