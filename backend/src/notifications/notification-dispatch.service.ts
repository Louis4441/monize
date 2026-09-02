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
import { PushTransport } from "../push/entities/push-subscription.entity";
import { EmailService } from "./email.service";
import { notificationImmediateTemplate } from "./email-templates";

/** How `notify` treats the fan-out relative to its own promise. */
/**
 * The per-category push copy, as English fallbacks; the catalogue key is
 * `push.notification.<category>` (lower-cased). One entry per category is
 * enforced by the type, and `notification-dispatch.service.spec.ts` holds the
 * `en` catalogue equal to these so the fallback and the catalogue cannot drift.
 */
export const PUSH_CATEGORY_COPY: Readonly<
  Record<NotificationCategory, { title: string; body: string }>
> = {
  [NotificationCategory.PAYMENTS]: {
    title: "Payment reminder",
    body: "A bill or scheduled payment needs your attention. Open Monize for the details.",
  },
  [NotificationCategory.BUDGETS]: {
    title: "Budget alert",
    body: "One of your budgets needs your attention. Open Monize for the details.",
  },
  [NotificationCategory.SYSTEM]: {
    title: "System notice",
    body: "Monize has a system notice for you. Open the app for the details.",
  },
};

export interface NotifyOptions {
  /**
   * `"await"` (the default) resolves after push and email were attempted --
   * right for a cron, which may wait for its deliveries. `"detached"` resolves
   * as soon as the row is committed and lets the fan-out run behind the caller:
   * for a producer on a request's READ path (bill reminders materialize on
   * `GET /notifications`), a stalled push endpoint -- up to
   * `PUSH_REQUEST_DEADLINE_MS` per device -- must not hold the reader past the
   * client's own timeout. Either way the fan-out never throws out of `notify`,
   * and a detached failure is logged exactly as an awaited one is.
   */
  fanOut?: "await" | "detached";
}

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
   * its own. A detached fan-out ({@link NotifyOptions.fanOut}) keeps that
   * ambient identity and opens its own short `withScopedDb` transactions for
   * every read it makes; nothing of it joins the caller's response.
   */
  async notify(
    userId: string,
    input: CreateNotificationInput,
    options: NotifyOptions = {},
  ): Promise<Notification | null> {
    const row = await this.notifications.create(userId, input);
    if (!row) return null;

    const delivery = this.fanOut(userId, row).catch((error: unknown) => {
      // Never let a delivery failure escape: the bell row stands regardless.
      this.logger.error(
        `Fan-out failed for notification ${row.id}`,
        error instanceof Error ? error.stack : error,
      );
    });
    if (options.fanOut !== "detached") await delivery;
    return row;
  }

  /** The notification-mode fan-out: the matrix decides the channels, the throttle gates them. */
  private async fanOut(userId: string, row: Notification): Promise<void> {
    const category = notificationCategoryOf(row.type);
    const delivery = await this.preferences.resolveNotificationDelivery(
      userId,
      category,
    );
    if (
      !delivery.push &&
      !delivery.unifiedpush &&
      !delivery.emailNotification
    ) {
      return;
    }

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

    // The two push channels ride the same encrypted Web Push wire and differ
    // only by which devices they reach, so one fan-out with the enabled
    // transport set (webpush for `push`, unifiedpush for `unifiedpush`) --
    // gated independently, delivered once.
    const transports: PushTransport[] = [];
    if (delivery.push) transports.push("webpush");
    if (delivery.unifiedpush) transports.push("unifiedpush");

    // Both interrupting channels are composed here, outside any request, so the
    // recipient's stored locale is resolved once and shared: the push copy and
    // the email frame must not disagree about the reader's language.
    const recipient = await this.resolveRecipient(
      userId,
      delivery.emailNotification,
    );
    if (transports.length > 0) {
      await this.push.sendToUser(
        userId,
        this.toPushPayload(row, category, recipient.lang),
        transports,
      );
    }
    if (delivery.emailNotification) {
      await this.sendEmail(recipient, row);
    }
  }

  /**
   * The recipient's stored language and, only when the email channel is on,
   * their address -- one tenant transaction either way. A push-only fan-out
   * (SYSTEM, or a category with notification email off) never needs the users
   * row, and the budget cron runs this once per new alert per user.
   */
  private async resolveRecipient(
    userId: string,
    withAddress: boolean,
  ): Promise<{ email: string | null; lang: string }> {
    return withScopedDb(this.dataSource, async (manager) => {
      const lang = await resolveUserEmailLocale(
        manager.getRepository(UserPreference),
        userId,
      );
      if (!withAddress) return { email: null, lang };
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: userId } });
      return { email: user?.email ?? null, lang };
    });
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

  /**
   * The push payload for a notification. Its `title`/`body` are the CATEGORY's
   * generic copy in the recipient's stored locale, not the row's own title and
   * message. Two reasons, either sufficient. The row's copy is composed by its
   * producer in English -- a budget alert names the category and the amounts --
   * and a Web Push body is rendered outside any request, so it follows the
   * email rule: `emailTranslator` against `user_preferences.language` (backend
   * CLAUDE.md, "Copy composed outside a request"). And the wire is encrypted end
   * to end (RFC 8291) but the lock screen is not, so the screen shows the
   * category and nothing of the money; the in-app row, one tap away through
   * `target`, carries the detail. The English fallbacks live in
   * {@link PUSH_CATEGORY_COPY} and the catalogue under `push.notification`.
   */
  private toPushPayload(
    row: Notification,
    category: NotificationCategory,
    lang: string,
  ): PushPayload {
    const t = emailTranslator(this.i18n, lang);
    const copy = PUSH_CATEGORY_COPY[category];
    const key = `push.notification.${category.toLowerCase()}`;
    return {
      type: row.type,
      title: t(`${key}.title`, copy.title),
      body: t(`${key}.body`, copy.body),
      target: row.target ?? undefined,
      // The subject this collapses onto: a system row's dedupe key, else the
      // row's own id (unique, so two distinct alerts never hide one another).
      // An id, never a name or amount -- a collapse key is metadata.
      collapseKey: row.dedupeKey ?? row.id,
    };
  }

  /** Render and send the immediate email in the recipient's locale, best-effort. */
  private async sendEmail(
    recipient: { email: string | null; lang: string },
    row: Notification,
  ): Promise<void> {
    if (!this.email.getStatus().configured) return;
    if (!recipient.email) return;

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
