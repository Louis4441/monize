import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationCategory } from "./entities/notification.entity";
import { NotificationPreference } from "./entities/notification-preference.entity";
import { THROTTLE_MAX_MINUTES } from "./notification-preference.constants";

export { THROTTLE_MAX_MINUTES };

/**
 * The categories the preference matrix exposes and a producer consults today.
 *
 * Deliberately NOT every {@link NotificationCategory}: the matrix shows a row
 * only where a producer actually reads the resolved value, so a toggle can
 * never be a control that changes nothing. `SYSTEM` earns its row because the
 * per-user `SCHEDULED_POST_FAILED` alert now fans out through
 * `NotificationDispatchService`, which reads this category's resolved push/email
 * decision -- a scheduled transaction failing to post is the affected user's
 * money not moving, so an opt-in push/email is a real control. The row governs a
 * user's OWN system notifications; the admin fan-out (`raiseAdminAlert`, a
 * cross-user recipient query) keeps its dedicated admin email and is not gated
 * by this matrix. See `docs/specs/notification-preferences.md`.
 */
export const NOTIFICATION_PREFERENCE_CATEGORIES: readonly NotificationCategory[] =
  [
    NotificationCategory.PAYMENTS,
    NotificationCategory.BUDGETS,
    NotificationCategory.SYSTEM,
  ];

/**
 * One category's resolved channel state for the settings matrix.
 *
 * `email` is the REPORT-mode email (the batch/digest, live and unthrottled) --
 * the channel `resolveEmail` gates. `emailNotification` is the NOTIFICATION-mode
 * email (immediate, one per event) and `throttleMinutes` its cooldown; both are
 * stored now and consumed with the push dispatch in Phase 5 (see spec section 4).
 */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
  emailNotification: boolean;
  push: boolean;
  throttleMinutes: number;
}

/** A partial update to one category's preferences. */
export interface NotificationPreferencePatch {
  email?: boolean;
  emailNotification?: boolean;
  push?: boolean;
  throttleMinutes?: number;
}

/**
 * Resolves and stores a user's per-category notification channel preferences.
 *
 * Backward compatibility is the load-bearing rule: an ABSENT row defaults the
 * report email ON, the notification email OFF and the throttle OFF (0), and the
 * global `user_preferences.notification_email` master switch still wins when
 * off. So an existing user keeps exactly today's delivery until they narrow a
 * category (spec section 10). Only the report email is live today; the
 * notification email and throttle are stored and rendered "coming soon" until
 * the Phase 5 push dispatch reads them.
 */
@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Whether REPORT-mode email should be delivered to this user for this
   * category, right now. The master switch off is a global kill; otherwise the
   * per-category row, defaulting on when absent. Safe to call inside a
   * producer's own `withUserContext` / `withSystemContext` -- the nested
   * `withScopedDb` joins the ambient transaction and reads under the ambient
   * identity.
   */
  async resolveEmail(
    userId: string,
    category: NotificationCategory,
  ): Promise<boolean> {
    return withScopedDb(this.dataSource, async (manager) => {
      const master = await manager.getRepository(UserPreference).findOne({
        where: { userId },
      });
      // The master is a kill switch: a per-category "on" never widens it. Test
      // falsiness, not `=== false`: notification_email is a nullable column, and
      // the producers this replaced blocked on `!prefs.notificationEmail`, so a
      // NULL master stays "off" here rather than silently flipping to "send".
      if (master && !master.notificationEmail) return false;
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return row ? row.email : true;
    });
  }

  /**
   * The notification-mode delivery decision for one category, in a single read:
   * whether the immediate email and push fan-outs are on, and the throttle
   * window that gates them. The one method the Phase 5 dispatch calls per
   * notification (spec section 14) -- combined so a fan-out costs one preference
   * read, not three.
   *
   * The email flag is killed by the `notification_email` master switch (it is
   * still email) and defaults OFF (opt-in, D9); push is NOT email-master-gated
   * (a different channel) and defaults OFF; the throttle defaults 0. Feasibility
   * -- SMTP configured, a live device -- is the sender's call, not this one.
   */
  async resolveNotificationDelivery(
    userId: string,
    category: NotificationCategory,
  ): Promise<{
    emailNotification: boolean;
    push: boolean;
    throttleMinutes: number;
  }> {
    return withScopedDb(this.dataSource, async (manager) => {
      const master = await manager.getRepository(UserPreference).findOne({
        where: { userId },
      });
      const emailKilled = !!master && !master.notificationEmail;
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return {
        emailNotification: emailKilled
          ? false
          : row
            ? row.emailNotification
            : false,
        push: row ? row.push : false,
        throttleMinutes: row ? this.clampThrottle(row.throttleMinutes) : 0,
      };
    });
  }

  /**
   * The per-category stored state for every matrix category, for the settings
   * UI. Deliberately NOT master-gated: the matrix shows the user's own
   * per-category choices, and the global email toggle is a separate control on
   * the same screen. Report email defaults on; notification email and throttle
   * default off.
   */
  async list(userId: string): Promise<NotificationChannelPreference[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = await manager.getRepository(NotificationPreference).find({
        where: { userId },
      });
      const byCategory = new Map(rows.map((row) => [row.category, row]));
      return NOTIFICATION_PREFERENCE_CATEGORIES.map((category) =>
        this.toChannelPreference(category, byCategory.get(category)),
      );
    });
  }

  /**
   * Update one category's preferences, creating the row if absent. Only the
   * fields present in `patch` are written; the rest keep their stored value (or
   * the column default on first insert).
   *
   * A single `INSERT ... ON CONFLICT (user_id, category) DO UPDATE` with
   * `COALESCE` rather than read-then-insert: two concurrent writes for the same
   * pair (a second tab or device, a retried request) would otherwise both miss
   * the row and the second INSERT would violate the primary key. `COALESCE($n,
   * <stored>)` is what makes it a partial upsert -- an omitted field passes NULL
   * and keeps the existing value. `updated_at` is bumped by the BEFORE UPDATE
   * trigger on the conflict path. The raw column names are checked against
   * `schema.sql` by `raw-sql-columns.spec.ts`.
   */
  async updatePreference(
    userId: string,
    category: NotificationCategory,
    patch: NotificationPreferencePatch,
  ): Promise<NotificationChannelPreference> {
    const email = patch.email === undefined ? null : patch.email;
    const emailNotification =
      patch.emailNotification === undefined ? null : patch.emailNotification;
    const push = patch.push === undefined ? null : patch.push;
    const throttle =
      patch.throttleMinutes === undefined
        ? null
        : this.clampThrottle(patch.throttleMinutes);

    return withScopedDb(this.dataSource, async (manager) => {
      await manager.query(
        `INSERT INTO notification_preferences
           (user_id, category, email, email_notification, throttle_minutes, push)
         VALUES ($1, $2, COALESCE($3, true), COALESCE($4, false),
                 COALESCE($5, 0), COALESCE($6, false))
         ON CONFLICT (user_id, category) DO UPDATE SET
           email = COALESCE($3, notification_preferences.email),
           email_notification =
             COALESCE($4, notification_preferences.email_notification),
           throttle_minutes =
             COALESCE($5, notification_preferences.throttle_minutes),
           push = COALESCE($6, notification_preferences.push)`,
        [userId, category, email, emailNotification, throttle, push],
      );
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return this.toChannelPreference(category, row);
    });
  }

  /** One category's channel state from its stored row (or the defaults). */
  private toChannelPreference(
    category: NotificationCategory,
    row: NotificationPreference | null | undefined,
  ): NotificationChannelPreference {
    return {
      category,
      email: row ? row.email : true,
      emailNotification: row ? row.emailNotification : false,
      push: row ? row.push : false,
      throttleMinutes: row ? this.clampThrottle(row.throttleMinutes) : 0,
    };
  }

  /** A stored or supplied window bounded to [0, THROTTLE_MAX_MINUTES]. */
  private clampThrottle(minutes: number): number {
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.min(THROTTLE_MAX_MINUTES, Math.trunc(minutes));
  }
}
