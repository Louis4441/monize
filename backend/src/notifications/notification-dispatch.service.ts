import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { I18nService } from "nestjs-i18n";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  CreateNotificationInput,
  NotificationService,
} from "../notification-center/notification.service";
import {
  Notification,
  NotificationCategory,
  notificationCategoryOf,
  severitiesAtOrAbove,
  typesForCategory,
} from "../notification-center/entities/notification.entity";
import { NotificationPreferenceService } from "../notification-center/notification-preference.service";
import { PushSubscriptionService } from "../push/push-subscription.service";
import { PushPayload } from "../push/web-push-sender.service";
import { EmailService } from "./email.service";
import { notificationImmediateTemplate } from "./email-templates";

/**
 * The dispatch seam (spec section 14.1): a layer ABOVE the write door that adds
 * the notification-mode fan-out (immediate email + push) after a notification is
 * written. A producer that wants fan-out calls `notify(...)` instead of
 * `NotificationService.create(...)`; a producer that only wants the bell row
 * keeps calling `create` directly. `create` stays the sole writer -- this never
 * writes a notification row -- and the in-app row is always written regardless of
 * the matrix or the throttle (Section 3).
 *
 * Lives in `NotificationsModule`, which imports `NotificationCenterModule` and
 * `PushModule` (both leaves) and holds `EmailService`, so the seam needs no
 * `forwardRef` and no require cycle (`module-graph.spec.ts`, INV-MODULE).
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
    private readonly preferences: NotificationPreferenceService,
    private readonly push: PushSubscriptionService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Write the notification (through the one write door) and fan it out.
   *
   * Returns the stored row, or `null` when `create` lost the ON CONFLICT race --
   * another replica holds this notification, so it is that replica's to fan out,
   * not ours (the same "null means not yours to email about" the write door
   * already gives). The fan-out is best-effort and never throws out of `notify`:
   * a failed push or email must not roll back the notification it is about, and
   * the row is already committed by `create` before any of it runs.
   *
   * Call it OUTSIDE any transaction whose failure it would report, exactly like
   * `create` -- it runs in the producer's ambient RLS context and seeds none of
   * its own.
   */
  async notify(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<Notification | null> {
    const row = await this.notifications.create(userId, input);
    if (!row) return null;

    try {
      await this.fanOut(userId, row);
    } catch (error) {
      // Never let a delivery failure escape: the bell row stands regardless.
      this.logger.error(
        `Fan-out failed for notification ${row.id}`,
        error instanceof Error ? error.stack : error,
      );
    }
    return row;
  }

  /** The notification-mode fan-out: the matrix decides the channels, the throttle gates them. */
  private async fanOut(userId: string, row: Notification): Promise<void> {
    const category = notificationCategoryOf(row.type);
    const delivery = await this.preferences.resolveNotificationDelivery(
      userId,
      category,
    );
    if (!delivery.push && !delivery.emailNotification) return;

    // The throttle gates BOTH interrupting channels; an escalation always goes.
    // A window of 0 disables the throttle for this category. The advisory lock
    // (D7) is taken whenever the throttle is active, on the push path as well as
    // the email one: two replicas can each win a DIFFERENT same-category row and
    // both read "no prior", and device-side collapse only merges re-sends of the
    // SAME row (its collapseKey is the row id / dedupe key), so two distinct rows
    // would show as two pushes the throttle meant to hold to one.
    const suppressed =
      delivery.throttleMinutes > 0 &&
      (await this.isThrottled(userId, category, row, delivery.throttleMinutes));
    if (suppressed) return;

    if (delivery.push) {
      await this.push.sendToUser(userId, this.toPushPayload(row));
    }
    if (delivery.emailNotification) {
      await this.sendEmail(userId, row);
    }
  }

  /**
   * Whether an interrupting delivery for this notification should be suppressed:
   * a same-category, non-dismissed notification created within the window
   * strictly BEFORE this one, whose severity is at least this one's (so a strict
   * escalation is never suppressed). "Same category" is a filter on the type set
   * the category maps to (the category is not stored).
   *
   * A per-(user, category) transaction advisory lock serialises concurrent
   * deciders (D7), so two same-group events racing across replicas cannot both
   * read "no prior" and both send -- the later decider blocks until the earlier
   * commits its row, then sees it and suppresses. Taken on every throttled path,
   * push included, because distinct rows do not collapse on the device.
   */
  private async isThrottled(
    userId: string,
    category: NotificationCategory,
    row: Notification,
    throttleMinutes: number,
  ): Promise<boolean> {
    const windowStart = new Date(
      new Date(row.createdAt).getTime() - throttleMinutes * 60_000,
    );
    return withScopedDb(this.dataSource, async (manager) => {
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`notif-fanout:${userId}:${category}`],
      );
      const rows = returnedRows<{ suppress: boolean }>(
        await manager.query(
          `SELECT EXISTS (
             SELECT 1 FROM notifications
              WHERE user_id = $1
                AND alert_type = ANY($2)
                AND dismissed_at IS NULL
                AND created_at > $3
                AND created_at < $4
                AND severity = ANY($5)
           ) AS suppress`,
          [
            userId,
            typesForCategory(category),
            windowStart,
            row.createdAt,
            severitiesAtOrAbove(row.severity),
          ],
        ),
      );
      return rows[0]?.suppress === true;
    });
  }

  /** The push payload for a notification -- privacy-minimal, no amounts or names. */
  private toPushPayload(row: Notification): PushPayload {
    return {
      type: row.type,
      title: row.title,
      body: row.message,
      target: row.target ?? undefined,
      // The subject this collapses onto: a system row's dedupe key, else the
      // row's own id (unique, so two distinct alerts never hide one another).
      // An id, never a name or amount -- a collapse key is metadata.
      collapseKey: row.dedupeKey ?? row.id,
    };
  }

  /** Render and send the immediate email in the recipient's locale, best-effort. */
  private async sendEmail(userId: string, row: Notification): Promise<void> {
    if (!this.email.getStatus().configured) return;

    const recipient = await withScopedDb(this.dataSource, async (manager) => {
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: userId } });
      if (!user?.email) return null;
      const lang = await resolveUserEmailLocale(
        manager.getRepository(UserPreference),
        userId,
      );
      return { email: user.email, lang };
    });
    if (!recipient) return;

    const appUrl = this.config.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    const target = row.target && row.target.startsWith("/") ? row.target : "";
    const t = emailTranslator(this.i18n, recipient.lang);
    const html = notificationImmediateTemplate(
      {
        title: row.title,
        message: row.message,
        url: `${appUrl}${target}`,
        severity: row.severity,
      },
      t,
    );
    const subject = t(
      "emails.notificationImmediate.subject",
      "You have a new Monize notification",
    );
    await this.email.sendMail(recipient.email, subject, html);
  }
}
