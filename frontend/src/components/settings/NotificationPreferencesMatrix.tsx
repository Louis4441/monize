'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { CheckIcon } from '@heroicons/react/24/solid';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  notificationPreferencesApi,
  type NotificationChannelPreference,
} from '@/lib/notification-preferences';
import type { NotificationCategory } from '@/types/notification';
import { createLogger } from '@/lib/logger';

const logger = createLogger('NotificationPreferencesMatrix');

/**
 * The per-category channel matrix. Rendered only where email is already on
 * globally (inside the SMTP-gated, master-email-on block of
 * NotificationsSection), so there is no master-gating to reason about here: the
 * bell (in-app) is always on and the only user-toggled channel is email. Push
 * and UnifiedPush columns arrive with their dispatch. See
 * `docs/specs/notification-preferences.md`.
 */
export function NotificationPreferencesMatrix() {
  const t = useTranslations('settings.notifications.preferences');
  const [rows, setRows] = useState<NotificationChannelPreference[] | null>(null);
  const [savingCategory, setSavingCategory] =
    useState<NotificationCategory | null>(null);

  useEffect(() => {
    let cancelled = false;
    notificationPreferencesApi
      .list()
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((error) => {
        // A matrix that will not load is not worth an error state; it simply
        // does not appear, which is where the product was before it existed.
        logger.debug('Could not load notification preferences', error);
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleEmail = useCallback(
    (category: NotificationCategory, current: boolean) => {
      setSavingCategory(category);
      // Optimistic: reflect the choice immediately, revert if the save fails.
      setRows(
        (prev) =>
          prev?.map((r) =>
            r.category === category ? { ...r, email: !current } : r,
          ) ?? prev,
      );
      void (async () => {
        try {
          await notificationPreferencesApi.setEmail(category, !current);
        } catch (error) {
          logger.error('Failed to save notification preference', error);
          setRows(
            (prev) =>
              prev?.map((r) =>
                r.category === category ? { ...r, email: current } : r,
              ) ?? prev,
          );
          toast.error(t('saveFailed'));
        } finally {
          setSavingCategory(null);
        }
      })();
    },
    [t],
  );

  if (rows === null || rows.length === 0) return null;

  return (
    <div className="border-t border-gray-200 pt-4 dark:border-gray-700">
      <h3 className="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('heading')}
      </h3>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        {t('description')}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
            <th className="pb-2 font-medium">{t('categoryHeader')}</th>
            <th className="pb-2 text-center font-medium">
              {t('channels.inApp')}
            </th>
            <th className="pb-2 text-center font-medium">
              {t('channels.email')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.category}
              className="border-t border-gray-100 dark:border-gray-800"
            >
              <td className="py-2 text-gray-700 dark:text-gray-300">
                {t(`categories.${row.category}`)}
              </td>
              <td className="py-2 text-center">
                <span
                  className="inline-flex items-center justify-center text-blue-600 dark:text-blue-400"
                  title={t('inAppAlways')}
                >
                  <CheckIcon className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">{t('inAppAlways')}</span>
                </span>
              </td>
              <td className="py-2">
                <div className="flex justify-center">
                  <ToggleSwitch
                    checked={row.email}
                    disabled={savingCategory === row.category}
                    onChange={() => toggleEmail(row.category, row.email)}
                    label={t('emailToggleLabel', {
                      category: t(`categories.${row.category}`),
                    })}
                    size="sm"
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
