'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/authStore';
import {
  classifyPushRegistration,
  currentDeviceFingerprint,
  getPushSupport,
  isInstalledIosWebApp,
  pushApi,
  pushPromptState,
  readRegisteredEndpoint,
  type PushConfig,
} from '@/lib/push';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('PushDiagnostics');

/**
 * Everything this browser and device report to Monize about notifications, in
 * one read-only dump.
 *
 * It exists because the failure users hit is invisible to the ordinary panel:
 * on Android the WEB permission (`Notification.permission`) can read `granted`
 * while the OS app-level notification toggle is OFF, so subscribing succeeds,
 * the push service accepts the test, and Android silently drops the display.
 * No web API reads that OS toggle directly, so the panel and the "test sent"
 * status both look healthy while nothing arrives.
 *
 * There is NO reliable web signal for this, and it was proven on a real device
 * (Android 10): all three permission APIs (`Notification.permission`,
 * `permissions.query`, `pushManager.permissionState`) read `granted`, and
 * `getNotifications()` returns the notification even while the OS suppresses its
 * display. So the panel dumps every signal for a human to read, and its
 * client-only self-test (`showNotification`, no server, no subscription) reports
 * only that the browser CREATED a notification without error -- never that the
 * system showed it, because nothing here can know that. The honest instruction
 * is to look for it and, if it is absent, enable notifications in the OS
 * settings.
 *
 * Field labels are the API identifiers being inspected, kept verbatim: this is a
 * diagnostic readout of names like `Notification.permission`, not prose to
 * translate. Only the chrome around it goes through the catalog.
 */

interface DiagnosticRow {
  label: string;
  value: string;
}

type LocalTest =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'created' }
  | { kind: 'error'; detail: string };

const TEST_DISPLAY_GRACE_MS = 400;

export function PushDiagnostics() {
  const t = useTranslations('settings.notifications.push.diagnostics');
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [rows, setRows] = useState<DiagnosticRow[]>([]);
  const [localTest, setLocalTest] = useState<LocalTest>({ kind: 'idle' });

  const gather = useCallback(async (): Promise<DiagnosticRow[]> => {
    const collected: DiagnosticRow[] = [];
    const add = (label: string, value: string) =>
      collected.push({ label, value });

    const hasNotification = typeof Notification !== 'undefined';
    const hasServiceWorker =
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
    const hasPushManager =
      typeof window !== 'undefined' && 'PushManager' in window;

    add('userAgent', typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a');
    add('Notification API', hasNotification ? 'present' : 'absent');
    add(
      'Notification.permission',
      hasNotification ? Notification.permission : 'n/a',
    );

    // The permissions API state, which is the same three values but read through
    // a different door -- worth showing side by side, because a disagreement is
    // itself a signal.
    if (
      typeof navigator !== 'undefined' &&
      'permissions' in navigator &&
      navigator.permissions?.query
    ) {
      try {
        const status = await navigator.permissions.query({
          name: 'notifications' as PermissionName,
        });
        add('permissions.query(notifications)', status.state);
      } catch (error) {
        add('permissions.query(notifications)', `error: ${getErrorMessage(error, 'failed')}`);
      }
    } else {
      add('permissions.query(notifications)', 'unsupported');
    }

    add('serviceWorker in navigator', hasServiceWorker ? 'yes' : 'no');
    add('PushManager in window', hasPushManager ? 'yes' : 'no');
    add(
      'display-mode: standalone',
      typeof window !== 'undefined' &&
        window.matchMedia?.('(display-mode: standalone)').matches
        ? 'yes'
        : 'no',
    );
    add(
      'navigator.standalone (iOS)',
      typeof navigator !== 'undefined'
        ? String(
            (navigator as Navigator & { standalone?: boolean }).standalone,
          )
        : 'n/a',
    );
    add('isInstalledIosWebApp()', isInstalledIosWebApp() ? 'yes' : 'no');

    const support = getPushSupport();
    add(
      'getPushSupport()',
      support.supported
        ? 'supported'
        : `blocked: ${support.reason ?? 'unknown'}`,
    );

    // The service worker and the browser's own push subscription. These two
    // decide whether a delivered push can even reach code that would show it.
    let fingerprint: string | null = null;
    if (hasServiceWorker) {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) {
          add('service worker', 'none registered');
        } else {
          const state = registration.active
            ? 'active'
            : registration.installing
              ? 'installing'
              : registration.waiting
                ? 'waiting'
                : 'unknown';
          add('service worker', `${state} (scope ${registration.scope})`);

          try {
            const subscription =
              await registration.pushManager.getSubscription();
            if (!subscription) {
              add('pushManager.getSubscription()', 'none');
            } else {
              const host = safeHost(subscription.endpoint);
              const expiry =
                subscription.expirationTime === null
                  ? 'no expiry'
                  : new Date(subscription.expirationTime).toISOString();
              add('pushManager.getSubscription()', `present (${host}, ${expiry})`);
              fingerprint = await currentDeviceFingerprint().catch(() => null);
            }
          } catch (error) {
            add(
              'pushManager.getSubscription()',
              `error: ${getErrorMessage(error, 'failed')}`,
            );
          }

          try {
            const state2 = await registration.pushManager.permissionState({
              userVisibleOnly: true,
            });
            add('pushManager.permissionState', state2);
          } catch (error) {
            add(
              'pushManager.permissionState',
              `error: ${getErrorMessage(error, 'failed')}`,
            );
          }
        }
      } catch (error) {
        add('service worker', `error: ${getErrorMessage(error, 'failed')}`);
      }
    }

    // The stored marker that says which account last registered THIS browser,
    // read the same way the panel reads it.
    const marker = readRegisteredEndpoint();
    add(
      'registeredEndpoint marker',
      marker === null
        ? 'none'
        : marker.userId === userId
          ? 'this account'
          : 'another account',
    );

    // The server's view: is the channel on, and does the server hold a live row
    // for this browser.
    let config: PushConfig | null = null;
    let registeredHere = false;
    try {
      config = await pushApi.getConfig();
      add(
        'server config',
        `enabled=${config.enabled}, publicKey=${config.publicKey ? 'set' : 'null'}, configured=${config.configured}`,
      );
    } catch (error) {
      add('server config', `error: ${getErrorMessage(error, 'failed')}`);
    }

    try {
      const devices = await pushApi.listDevices();
      const live = devices.filter((device) => !device.disabledAt);
      registeredHere =
        fingerprint !== null &&
        live.some((device) => device.endpointFingerprint === fingerprint);
      add(
        'server devices',
        `${devices.length} total, ${live.length} live, thisDevice=${registeredHere ? 'registered' : 'no'}`,
      );

      const registration = classifyPushRegistration({
        currentFingerprint: fingerprint,
        liveFingerprints: live.map((device) => device.endpointFingerprint),
        marker,
        readerUserId: userId,
      });
      add('classifyPushRegistration', registration.kind);
    } catch (error) {
      add('server devices', `error: ${getErrorMessage(error, 'failed')}`);
    }

    const prompt = pushPromptState({
      channelAvailable: !!config?.enabled && !!config.publicKey,
      support,
      registeredHere,
      installedIosWebApp: isInstalledIosWebApp(),
    });
    add('pushPromptState', prompt === null ? 'null' : prompt.kind);

    return collected;
  }, [userId]);

  const refresh = useCallback(() => {
    void gather()
      .then(setRows)
      .catch((error) => logger.debug('Diagnostics gather failed', error));
  }, [gather]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The permission and the OS/display state are all changed ELSEWHERE and
  // returned to, so re-read on the way back rather than trusting the mount read.
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState !== 'visible') return;
      refresh();
    };
    document.addEventListener('visibilitychange', reread);
    window.addEventListener('focus', reread);
    return () => {
      document.removeEventListener('visibilitychange', reread);
      window.removeEventListener('focus', reread);
    };
  }, [refresh]);

  /**
   * Show a notification straight from the service worker, then ask the
   * registration whether it is actually there. A created-but-absent notification
   * is the OS suppressing display -- the exact state a web permission of
   * `granted` cannot rule out on Android.
   *
   * Deliberately not async at the click boundary in the sense that matters: it
   * requests nothing (no permission prompt), it only shows -- so there is no
   * transient-activation constraint to respect here.
   */
  const runLocalTest = useCallback(async () => {
    setLocalTest({ kind: 'running' });
    try {
      if (typeof Notification === 'undefined') {
        setLocalTest({ kind: 'error', detail: 'Notification API absent' });
        return;
      }
      if (Notification.permission !== 'granted') {
        setLocalTest({
          kind: 'error',
          detail: `permission is ${Notification.permission}`,
        });
        return;
      }
      if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        setLocalTest({ kind: 'error', detail: 'no service worker' });
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        setLocalTest({ kind: 'error', detail: 'no service worker registration' });
        return;
      }
      const tag = `monize-diagnostic-${Date.now()}`;
      await registration.showNotification('Monize', {
        body: t('localTestBody'),
        tag,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_DISPLAY_GRACE_MS),
      );
      // Close it again so the probe leaves nothing behind. Deliberately NOT a
      // verdict: the OS suppresses the display while getNotifications still
      // lists the notification (proven on Android 10), so a non-empty result
      // cannot mean "the user saw it" -- and an empty one is not reliable the
      // other way either. No web API reveals the OS notification toggle, so the
      // honest report is "created, verify it visually", never "it works".
      const created = await registration.getNotifications({ tag });
      created.forEach((notification) => notification.close());
      setLocalTest({ kind: 'created' });
    } catch (error) {
      logger.error('Local notification test failed', error);
      setLocalTest({ kind: 'error', detail: getErrorMessage(error, 'failed') });
    }
  }, [t]);

  const copyReport = useCallback(async () => {
    const text = rows.map((row) => `${row.label}: ${row.value}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch (error) {
      logger.debug('Clipboard write failed', error);
    }
  }, [rows, t]);

  return (
    <details className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
      <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('summary')}
      </summary>

      <p className="mt-2 mb-3 text-sm text-gray-500 dark:text-gray-400">
        {t('intro')}
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={refresh}>
          {t('refresh')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={localTest.kind === 'running'}
          onClick={() => void runLocalTest()}
        >
          {localTest.kind === 'running' ? t('localTestRunning') : t('localTest')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={rows.length === 0}
          onClick={() => void copyReport()}
        >
          {t('copy')}
        </Button>
      </div>

      {localTest.kind === 'created' && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          {t('localTestCreated')}
        </p>
      )}
      {localTest.kind === 'error' && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          {t('localTestError', { detail: localTest.detail })}
        </p>
      )}

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-col border-b border-gray-100 py-1 sm:contents dark:border-gray-800"
          >
            <dt className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {row.label}
            </dt>
            <dd className="font-mono text-xs break-all text-gray-900 dark:text-gray-100">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** The endpoint is a delivery credential, so a diagnostic shows only its host. */
function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unparseable';
  }
}
