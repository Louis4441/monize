'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { CheckIcon } from '@heroicons/react/24/solid';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  notificationPreferencesApi,
  type NotificationChannelPreference,
  type NotificationPreferencePatch,
} from '@/lib/notification-preferences';
import type { NotificationCategory } from '@/types/notification';
import { createLogger } from '@/lib/logger';

const logger = createLogger('NotificationPreferencesMatrix');

/**
 * The per-category channel matrix. Rendered only where email is already on
 * globally (inside the SMTP-gated, master-email-on block of
 * NotificationsSection), so there is no master-gating to reason about here.
 *
 * In-app is always on (the bell shows every notification). Email has two modes:
 * the REPORT email (batch/digest -- the live, user-toggled channel) and the
 * NOTIFICATION email (immediate, one per event), which lands with the push
 * dispatch (Phase 5) and is rendered "coming soon" alongside its cooldown. See
 * `docs/specs/notification-preferences.md` section 4.
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

  // Optimistic: reflect the choice immediately, revert the whole row if the
  // save fails. Only the report email is editable today; the helper is written
  // for a patch so the notification-email column can reuse it in Phase 5.
  const applyPatch = useCallback(
    (
      category: NotificationCategory,
      patch: NotificationPreferencePatch,
      previous: NotificationChannelPreference,
    ) => {
      setSavingCategory(category);
      setRows(
        (prev) =>
          prev?.map((r) =>
            r.category === category ? { ...r, ...patch } : r,
          ) ?? prev,
      );
      void (async () => {
        try {
          await notificationPreferencesApi.update(category, patch);
        } catch (error) {
          logger.error('Failed to save notification preference', error);
          setRows(
            (prev) =>
              prev?.map((r) => (r.category === category ? previous : r)) ?? prev,
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
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
              <th className="pb-2 font-medium">{t('categoryHeader')}</th>
              <th className="pb-2 text-center font-medium">
                {t('channels.inApp')}
              </th>
              <th className="pb-2 text-center font-medium">
                {t('channels.emailReport')}
              </th>
              <th className="pb-2 text-center font-medium">
                {t('channels.emailNotification')}
              </th>
              <th className="pb-2 text-center font-medium">
                {t('throttle.label')}
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
                      onChange={() =>
                        applyPatch(row.category, { email: !row.email }, row)
                      }
                      label={t('emailToggleLabel', {
                        category: t(`categories.${row.category}`),
                      })}
                      size="sm"
                    />
                  </div>
                </td>
                {/* Notification email and cooldown land with the push dispatch
                    (Phase 5); until then they are stored but shown "coming
                    soon", the same pattern UnifiedPush uses. */}
                <td className="py-2 text-center">
                  <ComingSoon label={t('comingSoon')} />
                </td>
                <td className="py-2 text-center">
                  <ComingSoon label={t('comingSoon')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        {t('comingSoonNote')}
      </p>
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-400 dark:bg-gray-800 dark:text-gray-500">
      {label}
    </span>
  );
}
