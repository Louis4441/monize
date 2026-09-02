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

/** One category's stored channel state, as the matrix reads and writes it. */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
}

export const notificationPreferencesApi = {
  list: async (): Promise<NotificationChannelPreference[]> => {
    const response = await apiClient.get<NotificationChannelPreference[]>(
      '/notifications/preferences',
    );
    return response.data;
  },

  setEmail: async (
    category: NotificationCategory,
    email: boolean,
  ): Promise<NotificationChannelPreference> => {
    const response = await apiClient.put<NotificationChannelPreference>(
      `/notifications/preferences/${category}`,
      { email },
    );
    return response.data;
  },
};
