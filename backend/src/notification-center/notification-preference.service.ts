import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationCategory } from "./entities/notification.entity";
import { NotificationPreference } from "./entities/notification-preference.entity";

/**
 * The categories the preference matrix exposes and a producer consults today.
 *
 * Deliberately NOT every {@link NotificationCategory}: the matrix shows a row
 * only where a producer actually reads the resolved value, so a toggle can
 * never be a control that changes nothing. `SYSTEM` is absent because its email
 * is an admin fan-out (a cross-user recipient query), which lands with its own
 * care in a later slice; adding it here is one line plus that wiring. See
 * `docs/specs/notification-preferences.md`.
 */
export const NOTIFICATION_PREFERENCE_CATEGORIES: readonly NotificationCategory[] =
  [NotificationCategory.PAYMENTS, NotificationCategory.BUDGETS];

/**
 * The longest throttle window the matrix accepts, in minutes (24h). A window
 * beyond a day suppresses so much it reads as "off" done wrong; 0 is the real
 * "off". The DTO enforces the bound and the service clamps defensively.
 */
export const THROTTLE_MAX_MINUTES = 1440;

/** One category's resolved channel state for the settings matrix. */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
  /** Per-category throttle window in minutes; 0 disables. */
  throttleMinutes: number;
}

/** A partial update to one category's preferences. */
export interface NotificationPreferencePatch {
  email?: boolean;
  throttleMinutes?: number;
}

/**
 * Resolves and stores a user's per-category notification channel preferences.
 *
 * Backward compatibility is the load-bearing rule: an ABSENT row defaults email
 * ON and throttle OFF (0), and the global `user_preferences.notification_email`
 * master switch still wins when off. So an existing user, who has only ever had
 * the single master switch, keeps exactly today's behaviour until they narrow a
 * category -- the matrix narrows, it never widens an off master (spec section
 * 10). The aspirational per-category defaults in the spec are a later maintainer
 * decision, not applied here, because applying them would silently change
 * delivery for every existing user.
 */
@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Whether email should be delivered to this user for this category, right
   * now. The master switch off is a global kill; otherwise the per-category
   * row, defaulting on when absent. Safe to call inside a producer's own
   * `withUserContext` / `withSystemContext` -- the nested `withScopedDb` joins
   * the ambient transaction and reads under the ambient identity.
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
   * The throttle window for this user and category, in minutes; 0 (the default
   * for an absent row) means no throttle. Read by the notification write door
   * inside its own insert transaction -- the nested `withScopedDb` joins it, so
   * the value is read under the same transaction that decides the suppression.
   */
  async resolveThrottleMinutes(
    userId: string,
    category: NotificationCategory,
  ): Promise<number> {
    return withScopedDb(this.dataSource, async (manager) => {
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return row ? this.clampThrottle(row.throttleMinutes) : 0;
    });
  }

  /**
   * The per-category stored state (email default on, throttle default 0) for
   * every matrix category, for the settings UI. Deliberately NOT master-gated:
   * the matrix shows the user's own per-category choices, and the global email
   * toggle is a separate control on the same screen.
   */
  async list(userId: string): Promise<NotificationChannelPreference[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = await manager.getRepository(NotificationPreference).find({
        where: { userId },
      });
      const byCategory = new Map(rows.map((row) => [row.category, row]));
      return NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => {
        const row = byCategory.get(category);
        return {
          category,
          email: row ? row.email : true,
          throttleMinutes: row ? this.clampThrottle(row.throttleMinutes) : 0,
        };
      });
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
    const throttle =
      patch.throttleMinutes === undefined
        ? null
        : this.clampThrottle(patch.throttleMinutes);
    const email = patch.email === undefined ? null : patch.email;

    return withScopedDb(this.dataSource, async (manager) => {
      await manager.query(
        `INSERT INTO notification_preferences
           (user_id, category, email, throttle_minutes)
         VALUES ($1, $2, COALESCE($3, true), COALESCE($4, 0))
         ON CONFLICT (user_id, category) DO UPDATE SET
           email = COALESCE($3, notification_preferences.email),
           throttle_minutes =
             COALESCE($4, notification_preferences.throttle_minutes)`,
        [userId, category, email, throttle],
      );
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return {
        category,
        email: row ? row.email : true,
        throttleMinutes: row ? this.clampThrottle(row.throttleMinutes) : 0,
      };
    });
  }

  /** A stored or supplied window bounded to [0, THROTTLE_MAX_MINUTES]. */
  private clampThrottle(minutes: number): number {
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.min(THROTTLE_MAX_MINUTES, Math.trunc(minutes));
  }
}
