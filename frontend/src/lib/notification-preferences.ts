import apiClient from './api';
import type { NotificationCategory } from '@/types/notification';

/**
 * The categories the preference matrix exposes -- a subset of
 * {@link NotificationCategory}, mirroring the backend
 * `NOTIFICATION_PREFERENCE_CATEGORIES` and held equal by
 * `notification-preferences.contract.test.ts`. Only categories a producer
 * actually reads are shown, so a toggle never controls nothing.
 */
export const NOTIFICATION_PREFERENCE_CATEGORIES: readonly NotificationCategory[] =
  ['PAYMENTS', 'BUDGETS'];

/**
 * The throttle windows the matrix offers, in minutes. 0 is "off" (no throttle);
 * the rest are "suppress a repeat of this category for at most N minutes". A
 * stored value outside this list (set by another client) is still honoured --
 * the control adds it as an option so it is never silently dropped.
 */
export const THROTTLE_PRESET_MINUTES = [0, 5, 15, 30, 60, 180] as const;

/** One category's stored channel state, as the matrix reads and writes it. */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
  /** Per-category throttle window in minutes; 0 disables. */
  throttleMinutes: number;
}

/** A partial update: send only the field(s) that changed. */
export interface NotificationPreferencePatch {
  email?: boolean;
  throttleMinutes?: number;
}

export const notificationPreferencesApi = {
  list: async (): Promise<NotificationChannelPreference[]> => {
    const response = await apiClient.get<NotificationChannelPreference[]>(
      '/notifications/preferences',
    );
    return response.data;
  },

  update: async (
    category: NotificationCategory,
    patch: NotificationPreferencePatch,
  ): Promise<NotificationChannelPreference> => {
    const response = await apiClient.put<NotificationChannelPreference>(
      `/notifications/preferences/${category}`,
      patch,
    );
    return response.data;
  },
};
