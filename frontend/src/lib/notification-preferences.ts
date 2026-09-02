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
 * The cooldown windows the matrix offers, in minutes. 0 is "off"; the rest are
 * a minimum gap between notification-mode deliveries of a category. A stored
 * value off this list is still honoured -- the control adds it as an option.
 */
export const THROTTLE_PRESET_MINUTES = [0, 5, 15, 30, 60, 180] as const;

/**
 * One category's stored channel state.
 *
 * `email` is the REPORT-mode email (batch/digest -- live, unthrottled).
 * `emailNotification` is the NOTIFICATION-mode email (immediate) and
 * `throttleMinutes` its cooldown; both are stored now and become live with the
 * push dispatch (Phase 5), so the matrix renders them "coming soon".
 */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
  emailNotification: boolean;
  throttleMinutes: number;
}

/** A partial update: send only the field(s) that changed. */
export interface NotificationPreferencePatch {
  email?: boolean;
  emailNotification?: boolean;
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
