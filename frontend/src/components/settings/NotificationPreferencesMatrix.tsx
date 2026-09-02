'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { CheckIcon } from '@heroicons/react/24/solid';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  notificationPreferencesApi,
  NOTIFICATION_CATEGORY_CHANNELS,
  THROTTLE_OPTION_MINUTES,
  type NotificationChannelPreference,
  type NotificationPreferencePatch,
} from '@/lib/notification-preferences';
import { pushApi } from '@/lib/push';
import type { NotificationCategory } from '@/types/notification';
import { createLogger } from '@/lib/logger';

const logger = createLogger('NotificationPreferencesMatrix');

interface NotificationPreferencesMatrixProps {
  /**
   * Whether the email channel can deliver: SMTP is configured AND the master
   * email switch is on. The two email columns self-gate on it -- a per-category
   * email choice cannot widen a channel the master switch has closed.
   */
  emailAvailable: boolean;
}

/**
 * The per-category channel matrix. In-app is always on (the bell shows every
 * notification); email has two modes (the REPORT digest and the immediate
 * ALERT), push is the browser channel, and the cooldown gates the two
 * interrupting channels (alert email + push).
 *
 * It renders independent of the email master switch on purpose: push is a
 * separate channel (delivery isolation, discussion #1291), so nesting the whole
 * matrix inside the email-on block would hide push preferences whenever email is
 * off or unconfigured. Each column instead self-gates -- the email columns on
 * `emailAvailable`, the push column on there being a live device (a matrix cell
 * cannot grant the push permission, spec section 14.5). See
 * `docs/specs/notification-preferences.md`.
 */
export function NotificationPreferencesMatrix({
  emailAvailable,
}: NotificationPreferencesMatrixProps) {
  const t = useTranslations('settings.notifications.preferences');
  const [rows, setRows] = useState<NotificationChannelPreference[] | null>(null);
  const [savingCategory, setSavingCategory] =
    useState<NotificationCategory | null>(null);
  // A live device on a wire is what makes that wire's column a real control.
  // Counted per transport, because push (web push) and unifiedpush are gated
  // independently: a browser with a web-push device but no UnifiedPush endpoint
  // can toggle push, not unifiedpush. Absent or a failed lookup reads as "no
  // device" (0), erring toward disabling a toggle that could never deliver.
  const [liveWebPushCount, setLiveWebPushCount] = useState(0);
  const [liveUnifiedPushCount, setLiveUnifiedPushCount] = useState(0);

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

  useEffect(() => {
    let cancelled = false;
    pushApi
      .listDevices()
      .then((devices) => {
        if (!cancelled) {
          const live = devices.filter((device) => device.disabledAt === null);
          // A device from before the transport field reads as web push, today's
          // only wire -- never as UnifiedPush, so an old row cannot light a
          // column whose endpoint does not exist.
          setLiveWebPushCount(
            live.filter((d) => (d.transport ?? 'webpush') === 'webpush').length,
          );
          setLiveUnifiedPushCount(
            live.filter((d) => d.transport === 'unifiedpush').length,
          );
        }
      })
      .catch((error) => {
        // No device information means no push column, not an error.
        logger.debug('Could not load push devices', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Optimistic: reflect the choice immediately, revert the whole row if the
  // save fails. One helper for every channel and the cooldown alike.
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

  const pushAvailable = liveWebPushCount >= 1;
  const unifiedPushAvailable = liveUnifiedPushCount >= 1;

  // A cell for a channel this category does not expose as a control. The dash is
  // decorative; the meaning is carried by the localized label for assistive tech.
  const notApplicableCell = (
    <div className="flex justify-center">
      <span
        className="inline-flex items-center justify-center text-gray-300 dark:text-gray-600"
        title={t('channelNotApplicable')}
      >
        <span aria-hidden="true">&mdash;</span>
        <span className="sr-only">{t('channelNotApplicable')}</span>
      </span>
    </div>
  );

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
                {t('channels.push')}
              </th>
              <th className="pb-2 text-center font-medium">
                {t('channels.unifiedpush')}
              </th>
              <th className="pb-2 text-center font-medium">
                {t('throttle.label')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const categoryLabel = t(`categories.${row.category}`);
              const saving = savingCategory === row.category;
              // Which channels this category exposes as live controls -- from the
              // server (supportedChannels); the static map only shadows a row on
              // a response from a backend that predates the field.
              const support =
                row.supportedChannels ??
                NOTIFICATION_CATEGORY_CHANNELS[row.category];
              // The cooldown gates the interrupting channels, so it is only
              // meaningful once a SUPPORTED interrupting channel is on for the row.
              const interrupting =
                (support.emailNotification && row.emailNotification) ||
                (support.push && row.push) ||
                (support.unifiedpush && row.unifiedpush);
              return (
                <tr
                  key={row.category}
                  className="border-t border-gray-100 dark:border-gray-800"
                >
                  <td className="py-2 text-gray-700 dark:text-gray-300">
                    {categoryLabel}
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
                    {support.email ? (
                      <div className="flex justify-center">
                        <ToggleSwitch
                          checked={row.email}
                          disabled={saving || !emailAvailable}
                          onChange={() =>
                            applyPatch(row.category, { email: !row.email }, row)
                          }
                          label={t('emailToggleLabel', {
                            category: categoryLabel,
                          })}
                          size="sm"
                        />
                      </div>
                    ) : (
                      notApplicableCell
                    )}
                  </td>
                  <td className="py-2">
                    {support.emailNotification ? (
                      <div className="flex justify-center">
                        <ToggleSwitch
                          checked={row.emailNotification}
                          disabled={saving || !emailAvailable}
                          onChange={() =>
                            applyPatch(
                              row.category,
                              { emailNotification: !row.emailNotification },
                              row,
                            )
                          }
                          label={t('emailNotificationToggleLabel', {
                            category: categoryLabel,
                          })}
                          size="sm"
                        />
                      </div>
                    ) : (
                      notApplicableCell
                    )}
                  </td>
                  <td className="py-2">
                    {support.push ? (
                      <div className="flex justify-center">
                        <ToggleSwitch
                          checked={row.push}
                          disabled={saving || !pushAvailable}
                          onChange={() =>
                            applyPatch(row.category, { push: !row.push }, row)
                          }
                          label={t('pushToggleLabel', {
                            category: categoryLabel,
                          })}
                          size="sm"
                        />
                      </div>
                    ) : (
                      notApplicableCell
                    )}
                  </td>
                  <td className="py-2">
                    {support.unifiedpush ? (
                      <div className="flex justify-center">
                        <ToggleSwitch
                          checked={row.unifiedpush}
                          disabled={saving || !unifiedPushAvailable}
                          onChange={() =>
                            applyPatch(
                              row.category,
                              { unifiedpush: !row.unifiedpush },
                              row,
                            )
                          }
                          label={t('unifiedpushToggleLabel', {
                            category: categoryLabel,
                          })}
                          size="sm"
                        />
                      </div>
                    ) : (
                      notApplicableCell
                    )}
                  </td>
                  <td className="py-2 text-center">
                    <select
                      value={String(row.throttleMinutes)}
                      disabled={saving || !interrupting}
                      onChange={(event) =>
                        applyPatch(
                          row.category,
                          { throttleMinutes: Number(event.target.value) },
                          row,
                        )
                      }
                      aria-label={t('throttle.ariaLabel', {
                        category: categoryLabel,
                      })}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                    >
                      {THROTTLE_OPTION_MINUTES.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {t(`throttle.options.${minutes}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-gray-400 dark:text-gray-500">
        <li>{t('throttle.hint')}</li>
        {!emailAvailable && <li>{t('emailUnavailable')}</li>}
        {!pushAvailable && <li>{t('pushUnavailable')}</li>}
        {!unifiedPushAvailable && <li>{t('unifiedpushUnavailable')}</li>}
      </ul>
    </div>
  );
}
