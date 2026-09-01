import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { PushDiagnostics } from './PushDiagnostics';

// Keep the pure helpers real; stub only the network, so the mount gather does
// not reach axios.
vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: {
    getConfig: vi.fn().mockResolvedValue({
      enabled: true,
      publicKey: 'BPublicKey',
      configured: true,
      keyUnreadable: false,
    }),
    listDevices: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn(),
    removeDevice: vi.fn(),
    sendTest: vi.fn(),
  },
}));

/**
 * Put a "granted" web permission in front of a service worker whose
 * `getNotifications` returns exactly what the test wants -- the one signal that
 * separates "Android showed it" from "Android silently dropped it" while the web
 * permission reads `granted` either way.
 */
function installBrowser(getNotificationsResult: Array<{ close: () => void }>) {
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const getNotifications = vi.fn().mockResolvedValue(getNotificationsResult);
  const registration = {
    active: {},
    installing: null,
    waiting: null,
    scope: 'https://app.example/',
    showNotification,
    getNotifications,
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(null),
      permissionState: vi.fn().mockResolvedValue('granted'),
    },
  };
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { permission: 'granted' },
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue(registration) },
  });
  return { showNotification, getNotifications };
}

describe('PushDiagnostics local notification test', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis as object, 'Notification');
    Reflect.deleteProperty(navigator as object, 'serviceWorker');
  });

  async function renderAndRunTest() {
    await act(async () => {
      render(<PushDiagnostics />);
    });
    // Drain the mount gather's promise chain so nothing lands outside act.
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText('Show a test notification'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }

  it('reports blocked when the notification is created but not displayed', async () => {
    const { showNotification } = installBrowser([]); // OS suppressed the display
    await renderAndRunTest();

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/did not display it/i)).toBeInTheDocument();
    expect(screen.queryByText(/Notifications work on this device/i)).toBeNull();
  });

  it('reports shown when the notification is actually displayed', async () => {
    const close = vi.fn();
    installBrowser([{ close }]); // the notification is present afterwards
    await renderAndRunTest();

    expect(screen.getByText(/Notifications work on this device/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not display it/i)).toBeNull();
    // A shown notification is closed again so the check leaves nothing behind.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports an error rather than a false negative when permission is not granted', async () => {
    installBrowser([]);
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: { permission: 'default' },
    });
    await renderAndRunTest();

    // Not "blocked" -- there is nothing to display when we never had permission,
    // and calling it blocked would send the reader to fix the wrong thing.
    expect(screen.queryByText(/did not display it/i)).toBeNull();
    expect(screen.getByText(/Could not run the test/i)).toBeInTheDocument();
  });
});
