import {
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";

import { NotificationService } from "./notification.service";
import { DismissNotificationsQueryDto } from "./dto/dismiss-notifications-query.dto";
import { BudgetsService } from "../budgets/budgets.service";
import { Inject, forwardRef } from "@nestjs/common";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";

/**
 * The notification centre: what this account has been told, and what it has
 * done about it.
 *
 * These five endpoints lived on `BudgetsController` as `/budgets/alerts*` until
 * the table stopped being about budgets. The delegate rules come across
 * unchanged on purpose -- section `budgets`, the list readable, every write
 * closed -- because a move is not the moment to widen or narrow who may read
 * somebody else's notifications. Whether a delegate granted the budgets section
 * should see the owner's BACKUP_FAILED rows is a real question and a separate
 * one; it was already the answer here before this controller existed.
 */
@ApiTags("Notifications")
@Controller("notifications")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
@DelegateRequiresSection("budgets")
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    // Bill reminders are materialized on read rather than by a cron, so the
    // list endpoint asks their producer to catch up first. The edge is deferred
    // because BudgetsModule needs NotificationService to write through the one
    // door -- see `src/module-graph.spec.ts`.
    @Inject(forwardRef(() => BudgetsService))
    private readonly budgets: BudgetsService,
  ) {}

  @Get()
  @AllowDelegate()
  @ApiOperation({ summary: "Get this account's live notifications" })
  @ApiQuery({
    name: "unreadOnly",
    required: false,
    type: Boolean,
    description: "Only return unread notifications",
  })
  @ApiResponse({ status: 200, description: "Notifications retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async list(
    @Request() req,
    @Query("unreadOnly", new ParseBoolPipe({ optional: true }))
    unreadOnly?: boolean,
  ) {
    // Only the full list materializes pending bill reminders: the unread count
    // the bell polls must not write on every poll.
    if (!unreadOnly) {
      await this.budgets.ensureBillDueNotifications(req.user.id);
    }
    return this.notifications.list(req.user.id, {
      unreadOnly: unreadOnly || false,
    });
  }

  @Patch(":id/read")
  @ApiOperation({ summary: "Mark a notification as read" })
  @ApiParam({ name: "id", description: "Notification UUID" })
  @ApiResponse({ status: 200, description: "Notification marked as read" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Notification not found" })
  markRead(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.notifications.markRead(req.user.id, id);
  }

  @Patch("read-all")
  @ApiOperation({ summary: "Mark all notifications as read" })
  @ApiResponse({ status: 200, description: "All notifications marked as read" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  markAllRead(@Request() req) {
    return this.notifications.markAllRead(req.user.id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Dismiss a notification" })
  @ApiParam({ name: "id", description: "Notification UUID" })
  @ApiResponse({ status: 200, description: "Notification dismissed" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Notification not found" })
  dismiss(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.notifications.dismiss(req.user.id, id);
  }

  @Delete()
  @ApiOperation({
    summary: "Dismiss every notification matching the given filter",
  })
  @ApiQuery({
    name: "severity",
    required: false,
    enum: ["info", "warning", "critical", "success"],
    description: "Only dismiss notifications of this severity",
  })
  @ApiQuery({
    name: "category",
    required: false,
    enum: ["system", "financial"],
    description: "Only dismiss system or financial notifications",
  })
  @ApiResponse({ status: 200, description: "Matching notifications dismissed" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  dismissAll(@Request() req, @Query() query: DismissNotificationsQueryDto) {
    return this.notifications.dismissAll(req.user.id, query);
  }
}
