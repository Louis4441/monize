'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import {
  currentDeviceFingerprint,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  getPushSupport,
  isInstalledIosWebApp,
  pushApi,
  PushPermissionError,
  type PushConfig,
  type PushDevice,
  type PushSupport,
} from '@/lib/push';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('PushDevices');

/**
 * Browser push, from the account's own side: turn it on for this device, see
 * the devices this account has registered, send a test notification.
 *
 * The instance-level half -- whether this deployment offers push at all, and
 * the key pair behind it -- is an administrator's page. Nothing here reaches
 * another account's devices, and there is no route that could.
 */
export function PushDevicesPanel() {
  const t = useTranslations('settings.notifications.push');

  const [config, setConfig] = useState<PushConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [devicesFailed, setDevicesFailed] = useState(false);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEnabling, setIsEnabling] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    const [rows, fingerprint] = await Promise.all([
      pushApi.listDevices(),
      currentDeviceFingerprint().catch(() => null),
    ]);
    setDevices(rows);
    setThisDevice(fingerprint);
    setDevicesFailed(false);
  }, []);

  // A browser can rotate its subscription on its own; the worker resubscribes
  // and says so, and this is the surface that holds the session and the CSRF
  // token needed to register the replacement. Without it the row keeps naming a
  // dead endpoint and delivery stops with nothing to show for it.
  //
  // The message only reaches a page that is OPEN when the rotation happens,
  // which is the less likely case -- a rotation while the app is closed posts to
  // `clients.matchAll()` and finds nobody, so the reconciliation below is the
  // durable half. See `reconcileThisDevice`.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    // The container is captured, not re-read at teardown: an effect's cleanup
    // must not depend on a global still being what it was when it subscribed.
    const worker = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'monize-push-subscription-changed') return;
      void refreshDevices().catch(() => setDevicesFailed(true));
    };
    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
  }, [refreshDevices]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pushConfig = await pushApi.getConfig();
        if (cancelled) return;
        setConfig(pushConfig);
        setSupport(getPushSupport());
      } catch (error) {
        if (cancelled) return;
        // A failed read is not "push is off here". Rendering the panel as
        // disabled would tell the user to ask an administrator about a switch
        // that may be on.
        logger.error('Failed to load push configuration:', error);
        setConfigFailed(true);
        return;
      } finally {
        if (!cancelled) setIsLoading(false);
      }

      // Its own try, and its own failure: a device list that will not load says
      // nothing about whether push is available here, and folding the two
      // together hid a working Enable button behind "we could not check".
      try {
        await refreshDevices();
      } catch (error) {
        if (cancelled) return;
        logger.error('Failed to load push devices:', error);
        setDevicesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDevices]);

  /**
   * Register the subscription this browser holds when the server has no live row
   * for it.
   *
   * The case this exists for: the push service rotated the subscription while
   * the app was closed. The worker resubscribed and posted a message to every
   * open window -- there were none -- so the browser now holds an endpoint the
   * server has never seen, and the server holds a row naming a dead one. The
   * device list showed that row as active, so the interface asserted delivery
   * was working while nothing could be delivered, and the only recovery was a
   * button the user had no reason to press.
   *
   * Only ever with permission already `granted`: that is what makes this a
   * re-registration of something the user consented to rather than a permission
   * request without a gesture, which iOS would answer `default` with no prompt
   * shown. Once per mount, so a server that keeps refusing cannot become a loop.
   */
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    if (!config?.enabled || !config.publicKey) return;
    if (thisDevice === null) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const known = devices.some(
      (device) =>
        device.endpointFingerprint === thisDevice && !device.disabledAt,
    );
    if (known) return;
    reconciled.current = true;
    (async () => {
      try {
        await enablePushOnThisDevice(config.publicKey!, defaultDeviceName());
        await refreshDevices();
      } catch (error) {
        // Best effort and silent: the user did not ask for this, and the Enable
        // button is still there for them if it fails.
        logger.error('Failed to re-register a rotated push subscription:', error);
      }
    })();
  }, [config, thisDevice, devices, refreshDevices]);

  // A retired row is not a registration: after a key rotation the device is
  // listed with the copy telling the user to enable push again, and hiding the
  // button on the strength of that row left them with the instruction and no
  // way to follow it.
  const registeredHere = devices.find(
    (device) =>
      thisDevice !== null &&
      device.endpointFingerprint === thisDevice &&
      !device.disabledAt,
  );
  const liveDevices = devices.filter((device) => !device.disabledAt);

  // Deliberately NOT an async function. The permission prompt only appears
  // while the click's transient activation lasts, and iOS spends that on the
  // first suspension -- so the work is started synchronously, before the state
  // update, and only the reporting happens after an await. Written as
  // `async () => { setIsEnabling(true); await enablePushOnThisDevice(...) }`
  // this asked for a permission the user was then told they had not granted,
  // with no prompt ever shown.
  const handleEnable = () => {
    if (!config?.publicKey) return;
    const enabling = enablePushOnThisDevice(
      config.publicKey,
      defaultDeviceName(),
    );
    setIsEnabling(true);
    void (async () => {
      try {
        await enabling;
        await refreshDevices();
        toast.success(t('toasts.enabled'));
      } catch (error) {
        if (error instanceof PushPermissionError) {
          toast.error(permissionMessage(error));
        } else {
          toast.error(getErrorMessage(error, t('toasts.enableFailed')));
        }
      } finally {
        setIsEnabling(false);
      }
    })();
  };

  /**
   * Which refusal to report. `denied` is a decision the user can undo in site
   * settings. `dismissed` normally means they closed the prompt -- except on an
   * installed iOS web app, where it is also what a prompt that never appeared
   * looks like, and telling that user to "choose Allow when the browser asks"
   * sends them to look for a dialogue that is not coming.
   */
  const permissionMessage = (error: PushPermissionError): string => {
    if (error.reason === 'denied') return t('toasts.permissionDenied');
    return isInstalledIosWebApp()
      ? t('toasts.permissionNoPrompt')
      : t('toasts.permissionDismissed');
  };

  const handleRemove = async (device: PushDevice) => {
    setRemovingId(device.id);
    try {
      const isThisBrowser = device.endpointFingerprint === thisDevice;
      if (isThisBrowser) {
        // Both halves: the server row AND the browser subscription. Leaving
        // either behind is a device the user can neither receive on nor see.
        await disablePushOnThisDevice(device.id);
      } else {
        await pushApi.removeDevice(device.id);
      }
      await refreshDevices();
      toast.success(t('toasts.removed'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.removeFailed')));
    } finally {
      setRemovingId(null);
    }
  };

  const handleSendTest = async () => {
    setIsSendingTest(true);
    try {
      const result = await pushApi.sendTest();
      await refreshDevices();
      if (result.delivered === result.attempted) {
        toast.success(t('toasts.testSent', { count: result.delivered }));
      } else if (result.delivered > 0) {
        toast.success(
          t('toasts.testPartial', {
            delivered: result.delivered,
            attempted: result.attempted,
          }),
        );
      } else {
        toast.error(t('toasts.testFailed'));
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.testFailed')));
    } finally {
      setIsSendingTest(false);
    }
  };

  if (isLoading) return null;

  if (configFailed) {
    return (
      <PushBlock heading={t('heading')}>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('statusUnavailable')}
        </p>
      </PushBlock>
    );
  }

  if (!config?.enabled) {
    // Three reasons, three messages. A key pair the server cannot read is not
    // an administrator's decision, and saying it is sends the reader to ask
    // somebody who has nothing to change.
    const reason = !config?.configured
      ? 'notConfigured'
      : config.keyUnreadable
        ? 'keyUnreadable'
        : 'disabledByAdmin';
    return (
      <PushBlock heading={t('heading')}>
        <p className="text-sm text-gray-500 dark:text-gray-400">{t(reason)}</p>
      </PushBlock>
    );
  }

  // A browser that cannot receive push still has to be able to SEE and REMOVE
  // the devices this account registered elsewhere -- suppressing the list left a
  // user with no way to revoke a device from the machine they were sitting at.
  const unsupportedReason =
    support && !support.supported
      ? (support.reason ?? 'unsupported')
      : undefined;

  return (
    <PushBlock heading={t('heading')}>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        {unsupportedReason
          ? t(`unsupported.${unsupportedReason}`)
          : t('description')}
      </p>

      {devicesFailed && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          {t('devicesUnavailable')}
        </p>
      )}

      {devices.length > 0 && (
        <ul className={`mb-4 ${TABLE_BODY_CLASS}`}>
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-gray-900 dark:text-gray-100">
                  {device.deviceName || t('unnamedDevice')}
                  {device.endpointFingerprint === thisDevice && (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                      {t('thisDevice')}
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {device.disabledAt
                    ? t(`disabledReason.${device.disabledReason ?? 'GONE'}`)
                    : t('lastSeen', {
                        when: new Date(device.lastSeenAt).toLocaleString(),
                      })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={removingId === device.id}
                onClick={() => handleRemove(device)}
              >
                {t('removeButton')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {!registeredHere && !unsupportedReason && (
          <Button
            variant="outline"
            size="sm"
            disabled={isEnabling}
            onClick={handleEnable}
          >
            {isEnabling ? t('enablingButton') : t('enableButton')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={isSendingTest || liveDevices.length === 0}
          onClick={handleSendTest}
        >
          {isSendingTest ? t('sendingTestButton') : t('sendTestButton')}
        </Button>
      </div>

      {liveDevices.length === 0 && !unsupportedReason && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('noLiveDevices')}
        </p>
      )}
    </PushBlock>
  );
}

function PushBlock({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-gray-200 pt-4 dark:border-gray-700">
      <h3 className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {heading}
      </h3>
      {children}
    </div>
  );
}

/**
 * A name the user will recognise in their own device list, from the platform the
 * browser reports. Only ever a default -- the field is theirs to change later.
 */
export function defaultDeviceName(
  nav: Navigator = navigator,
): string | undefined {
  const ua = nav.userAgent;
  if (!ua) return undefined;
  const platform = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Macintosh/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  if (!platform && !browser) return undefined;
  return [browser, platform].filter(Boolean).join(' on ');
}
