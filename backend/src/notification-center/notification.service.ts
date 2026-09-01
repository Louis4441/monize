import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, EntityManager, In, IsNull, LessThan, Not } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  SYSTEM_NOTIFICATION_TYPES,
  notificationCategoryOf,
} from "./entities/notification.entity";
import { DismissNotificationsQueryDto } from "./dto/dismiss-notifications-query.dto";

// The three column widths the door truncates on. Each is checked against
// `database/schema.sql` by `notification-category.spec.ts`: a bound that is too
// low silently shortens copy the column would have taken, and one that is too
// high hands PostgreSQL a value it refuses with 22001 -- inside a producer's
// never-throws catch, which is the failure the truncation exists to prevent.

/** Matches notifications.title. */
export const TITLE_MAX_LENGTH = 255;

/** Matches notifications.dedupe_key. */
export const DEDUPE_KEY_MAX_LENGTH = 120;

/** Matches notifications.target. */
export const TARGET_MAX_LENGTH = 255;

/** How long a dismissed or read notification is kept before the purge. */
export const RETENTION_DAYS = 30;

/** The newest notifications one list read returns. */
export const LIST_PAGE_SIZE = 50;

/**
 * One notification to write. Every producer builds this; nothing else reaches
 * the table.
 */
export interface CreateNotificationInput {
  type: NotificationType;
  severity: NotificationSeverity;
  /**
   * Stored English fallback, for a reader with no client to render the row
   * (the email digest, an API consumer). The UI composes its own copy from
   * `type` and `data` in the reader's language.
   */
  title: string;
  /** Stored English fallback, as `title`. */
  message: string;
  /**
   * Facts for client-side localization. Never a value that goes stale while
   * the row lives -- "due in 3 days" was true when it was written.
   */
  data?: Record<string, unknown>;
  /**
   * Where the bell sends the reader, as a same-origin path (`/budgets/<id>`),
   * never a URL. The service worker resolves it against the app's own origin
   * and discards anything that leaves it.
   */
  target?: string | null;
  /** The date the notification is about. Defaults to today. */
  periodStart?: string;
  budgetId?: string | null;
  budgetCategoryId?: string | null;
  /**
   * Explicit fingerprint for a notification the fingerprint index cannot
   * arbitrate -- one with `budgetId` null, where NULL never equals NULL.
   * Unique per `(user_id, dedupe_key)`.
   */
  dedupeKey?: string | null;
}

/**
 * A notification as a reader sees it: the row, plus the category derived from
 * its type. There is no `category` column -- see `notificationCategoryOf`.
 */
export type NotificationView = Notification & {
  category: NotificationCategory;
};

function withCategory(row: Notification): NotificationView {
  return { ...row, category: notificationCategoryOf(row.type) };
}

/** Today as the DATE the NOT NULL period_start column requires. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The notification table's one door, in both directions: every producer writes
 * through `create`, and every reader -- the bell, the list, the dismiss-all --
 * reads through the methods below.
 *
 * **Why one creation door.** Before this there were three inserts with three
 * different opinions: a raw `INSERT` for budget alerts, an entity `save` for
 * bill reminders, and a second raw `INSERT` for system alerts -- so the column
 * bounds were enforced on one path, the conflict handling on another, and the
 * `period_start` default on a third. A producer decides *what* to say; the
 * shape of the row it lands in is not its decision to make.
 * `notification-write-door.spec.ts` fails on a second writer.
 *
 * **What a conflict means.** The insert is `ON CONFLICT DO NOTHING`, covering
 * both unique indexes at once: the fingerprint (a budget notification the
 * period already holds) and the dedupe key (a system notification another
 * replica already raised). `null` therefore means *somebody else holds this
 * notification*, which is what every caller needs to know -- notably, that it
 * is not theirs to email about. It is deliberately not an error: every replica
 * runs every cron, so losing the race is the normal case.
 *
 * **Context.** `withScopedDb` throws without an ambient identity, and every
 * producer here is a cron body, a post-claim hook or a bootstrap hook with no
 * request behind it -- so callers seed their own (`withUserContext` for the
 * affected user, `withSystemContext` for an admin fan-out) and this service
 * inherits it. `create` joins an ambient transaction if there is one, which is
 * why producers must call it OUTSIDE the transaction whose failure they are
 * reporting: a notification that rolls back with the work it describes is a
 * notification nobody gets.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Write one notification, or report that somebody already holds it.
   *
   * Returns the stored row -- read back inside the same transaction as the
   * insert, so what the caller emails about is what the database has -- or
   * `null` when a unique index refused it.
   */
  async create(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<Notification | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ id: string }>(
        await manager.query(
          `INSERT INTO notifications
             (user_id, budget_id, budget_category_id, alert_type, severity,
              title, message, data, target, period_start, dedupe_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            userId,
            input.budgetId ?? null,
            input.budgetCategoryId ?? null,
            input.type,
            input.severity,
            this.boundedTitle(input.type, input.title),
            input.message,
            JSON.stringify(input.data ?? {}),
            this.boundedTarget(input.type, input.target),
            input.periodStart ?? todayIsoDate(),
            this.boundedDedupeKey(input.type, input.dedupeKey),
          ],
        ),
      );
      const id = rows[0]?.id;
      if (id === undefined) return null;

      // An `ON CONFLICT DO NOTHING` that wrote a row still has to be read back
      // as authoritative state rather than assembled from the input: the
      // defaults, the trigger-stamped timestamps and the truncations above all
      // live in the database.
      return (
        (await manager
          .getRepository(Notification)
          .findOne({ where: { id } })) ?? null
      );
    });
  }

  /**
   * Record that this notification's email went out.
   *
   * Here rather than at the producer so the table has one writer: a producer
   * that loaded the row and saved it back would be a second place deciding what
   * a notification row looks like, and the guard scan could no longer tell a
   * flag update from a create.
   */
  async markEmailSent(notificationId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE notifications SET is_email_sent = true WHERE id = $1`,
        [notificationId],
      ),
    );
  }

  /** The reader's live notifications, newest first. */
  async list(
    userId: string,
    options: { unreadOnly?: boolean } = {},
  ): Promise<NotificationView[]> {
    const where: Record<string, unknown> = { userId, dismissedAt: IsNull() };
    if (options.unreadOnly) {
      where.isRead = false;
    }

    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Notification).find({
        where,
        order: { createdAt: "DESC" },
        take: LIST_PAGE_SIZE,
      }),
    );

    return rows.map(withCategory);
  }

  async markRead(
    userId: string,
    notificationId: string,
  ): Promise<NotificationView> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(Notification);
      const row = await this.requireLive(manager, userId, notificationId);
      row.isRead = true;
      return withCategory(await repo.save(row));
    });
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Notification)
        .update(
          { userId, isRead: false, dismissedAt: IsNull() },
          { isRead: true },
        ),
    );
    return { updated: result.affected || 0 };
  }

  async dismiss(userId: string, notificationId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const row = await this.requireLive(manager, userId, notificationId);
      row.dismissedAt = new Date();
      await manager.getRepository(Notification).save(row);
    });
  }

  /**
   * Soft-dismiss every live notification matching the caller's filter, in one
   * UPDATE. The filter arrives explicitly on the command (severity and/or
   * system-vs-financial category) rather than as a list of on-screen ids, so
   * it also reaches notifications beyond the list endpoint's window.
   * Financial is defined as NOT IN `SYSTEM_NOTIFICATION_TYPES` -- the one
   * place the partition is written.
   */
  async dismissAll(
    userId: string,
    filters: DismissNotificationsQueryDto = {},
  ): Promise<{ dismissed: number }> {
    const where: Record<string, unknown> = { userId, dismissedAt: IsNull() };
    if (filters.severity) {
      where.severity = filters.severity;
    }
    if (filters.category === "system") {
      where.type = In([...SYSTEM_NOTIFICATION_TYPES]);
    } else if (filters.category === "financial") {
      where.type = Not(In([...SYSTEM_NOTIFICATION_TYPES]));
    }

    const result = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Notification)
        .update(where, { dismissedAt: new Date() }),
    );
    return { dismissed: result.affected || 0 };
  }

  /**
   * Drop notifications the reader is done with: dismissed a while ago, or read
   * and left alone. An unread one is never purged -- it is the only record the
   * user has that something happened.
   */
  @Cron("0 3 * * *")
  async purgeOld(): Promise<void> {
    this.logger.log("Purging old notifications...");
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

      // Cross-user bulk purge, so it runs under a system context (task C2).
      const { dismissed, read } = await withSystemContext(async () => {
        const dismissedResult = await withScopedDb(this.dataSource, (manager) =>
          manager
            .getRepository(Notification)
            .delete({ dismissedAt: LessThan(cutoff) }),
        );
        const readResult = await withScopedDb(this.dataSource, (manager) =>
          manager.getRepository(Notification).delete({
            isRead: true,
            dismissedAt: IsNull(),
            createdAt: LessThan(cutoff),
          }),
        );
        return {
          dismissed: dismissedResult.affected || 0,
          read: readResult.affected || 0,
        };
      });

      if (dismissed + read > 0) {
        this.logger.log(
          `Purged ${dismissed} dismissed and ${read} old read notifications`,
        );
      }
    } catch (error) {
      this.logger.error(
        "Failed to purge old notifications",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /**
   * The caller's own live notification, or a 404. "Not theirs" and "already
   * dismissed" are deliberately the same answer: both mean there is nothing
   * here for this reader to act on, and distinguishing them would say whether
   * an id exists.
   */
  private async requireLive(
    manager: EntityManager,
    userId: string,
    notificationId: string,
  ): Promise<Notification> {
    const row = await manager.getRepository(Notification).findOne({
      where: { id: notificationId, userId, dismissedAt: IsNull() },
    });
    if (!row) {
      throw new NotFoundException(
        tr(
          "errors.budgets.alertNotFound",
          `Alert with ID ${notificationId} not found`,
          { id: notificationId },
        ),
      );
    }
    return row;
  }

  /**
   * A title the `title VARCHAR(255)` column will accept.
   *
   * Producers interpolate names they do not control -- a scheduled
   * transaction's, an account's -- and an over-long one makes PostgreSQL raise
   * 22001, which a producer's never-throws contract then swallows: the
   * notification silently never exists, and for SCHEDULED_POST_FAILED that
   * means the user is never told their money did not move. Truncating is the
   * honest failure, and it happens once, here, rather than at each producer.
   */
  private boundedTitle(type: NotificationType, title: string): string {
    if (title.length <= TITLE_MAX_LENGTH) return title;
    this.logger.warn(
      `Title for ${type} exceeds ${TITLE_MAX_LENGTH} chars and was truncated`,
    );
    return `${title.slice(0, TITLE_MAX_LENGTH - 1)}…`;
  }

  /**
   * Keys are bounded by construction (type + UUID + date is well under the
   * column); a longer one is a producer bug, reported and truncated
   * deterministically rather than thrown, because the notification still
   * deduping -- slightly too coarsely -- beats the sweep that raised it dying
   * here.
   */
  private boundedDedupeKey(
    type: NotificationType,
    dedupeKey: string | null | undefined,
  ): string | null {
    if (dedupeKey === null || dedupeKey === undefined) return null;
    if (dedupeKey.length <= DEDUPE_KEY_MAX_LENGTH) return dedupeKey;
    this.logger.error(
      `Dedupe key for ${type} exceeds ${DEDUPE_KEY_MAX_LENGTH} chars ` +
        `and was truncated: ${dedupeKey.slice(0, 60)}...`,
    );
    return dedupeKey.slice(0, DEDUPE_KEY_MAX_LENGTH);
  }

  /**
   * A truncated path points somewhere else, so an over-long target is dropped
   * rather than cut: a notification with no link is worse than one with the
   * right link and better than one that navigates to the wrong page.
   */
  private boundedTarget(
    type: NotificationType,
    target: string | null | undefined,
  ): string | null {
    if (target === null || target === undefined) return null;
    if (target.length <= TARGET_MAX_LENGTH) return target;
    this.logger.error(
      `Target for ${type} exceeds ${TARGET_MAX_LENGTH} chars and was dropped`,
    );
    return null;
  }
}
