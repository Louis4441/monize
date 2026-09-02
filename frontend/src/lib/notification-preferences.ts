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
  ['PAYMENTS', 'BUDGETS', 'SYSTEM'];

/**
 * The cooldown windows the matrix offers, in minutes. `0` is the real "off";
 * the ceiling mirrors the backend `THROTTLE_MAX_MINUTES` (24h) -- a window
 * beyond a day suppresses so much it reads as "off" done wrong. Each option is
 * labelled by a full catalog string a translator can localise.
 */
export const THROTTLE_OPTION_MINUTES: readonly number[] = [
  0, 5, 15, 30, 60, 360, 1440,
];

/**
 * One category's stored channel state.
 *
 * `email` is the REPORT-mode email (batch/digest -- live, unthrottled).
 * `emailNotification` is the NOTIFICATION-mode email (immediate, one per event),
 * `push` the browser push, and `throttleMinutes` the cooldown that gates both
 * interrupting channels. All four are live (Phase 5).
 */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
  emailNotification: boolean;
  push: boolean;
  throttleMinutes: number;
}

/** A partial update: send only the field(s) that changed. */
export interface NotificationPreferencePatch {
  email?: boolean;
  emailNotification?: boolean;
  push?: boolean;
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
