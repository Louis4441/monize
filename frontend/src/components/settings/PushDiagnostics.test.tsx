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
 * A "granted" web permission in front of a service worker. `getNotifications`
 * deliberately returns a notification even in the blocked case: that is the
 * real Android 10 behaviour (the OS hides the display while the notification is
 * still listed), so the panel must NOT read a non-empty result as "it works".
 */
function installBrowser(options: { showRejects?: boolean } = {}) {
  const close = vi.fn();
  const showNotification = options.showRejects
    ? vi.fn().mockRejectedValue(new Error('blocked by system'))
    : vi.fn().mockResolvedValue(undefined);
  const registration = {
    active: {},
    installing: null,
    waiting: null,
    scope: 'https://app.example/',
    showNotification,
    getNotifications: vi.fn().mockResolvedValue([{ close }]),
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
  return { showNotification, close };
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

  it('reports only "created" with a caveat, never that notifications work', async () => {
    const { showNotification, close } = installBrowser();
    await renderAndRunTest();

    expect(showNotification).toHaveBeenCalledTimes(1);
    // The honest message: nothing here can confirm the OS showed it, and it
    // points at the device settings. No web API can promise more.
    expect(
      screen.getByText(/nothing here can confirm the system actually showed it/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/enable notifications for Monize in your device settings/i),
    ).toBeInTheDocument();
    // The probe cleans up the notification it created.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports an error when showNotification rejects, not a pass', async () => {
    installBrowser({ showRejects: true });
    await renderAndRunTest();

    expect(screen.getByText(/Could not run the test/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing here can confirm/i)).toBeNull();
  });

  it('reports an error rather than a false result when permission is not granted', async () => {
    installBrowser();
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: { permission: 'default' },
    });
    await renderAndRunTest();

    expect(screen.getByText(/Could not run the test/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing here can confirm/i)).toBeNull();
  });
});
