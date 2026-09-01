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

/** One category's resolved channel state for the settings matrix. */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
}

/**
 * Resolves and stores a user's per-category notification channel preferences.
 *
 * Backward compatibility is the load-bearing rule: an ABSENT row defaults email
 * ON, and the global `user_preferences.notification_email` master switch still
 * wins when off. So an existing user, who has only ever had the single master
 * switch, keeps exactly today's behaviour until they narrow a category -- the
 * matrix narrows, it never widens an off master (spec section 10). The
 * aspirational per-category defaults in the spec are a later maintainer
 * decision, not applied here, because applying them would silently turn some
 * email off for every existing user.
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
      // The master is a kill switch: a per-category "on" never widens it.
      if (master && master.notificationEmail === false) return false;
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return row ? row.email : true;
    });
  }

  /**
   * The per-category stored state (default on) for every matrix category, for
   * the settings UI. Deliberately NOT master-gated: the matrix shows the user's
   * own per-category choices, and the global email toggle is a separate control
   * on the same screen.
   */
  async list(userId: string): Promise<NotificationChannelPreference[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = await manager.getRepository(NotificationPreference).find({
        where: { userId },
      });
      const byCategory = new Map(rows.map((row) => [row.category, row.email]));
      return NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => ({
        category,
        email: byCategory.get(category) ?? true,
      }));
    });
  }

  /** Set the email preference for one category, creating the row if absent. */
  async setEmail(
    userId: string,
    category: NotificationCategory,
    email: boolean,
  ): Promise<NotificationChannelPreference> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(NotificationPreference);
      const existing = await repo.findOne({ where: { userId, category } });
      if (existing) {
        existing.email = email;
        await repo.save(existing);
      } else {
        await repo.save(repo.create({ userId, category, email }));
      }
      return { category, email };
    });
  }
}
