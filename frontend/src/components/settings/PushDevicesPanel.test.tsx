import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import { PushDevicesPanel, defaultDeviceName } from './PushDevicesPanel';
import toast from 'react-hot-toast';
import { PushPermissionError, type PushDevice } from '@/lib/push';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

const mockGetConfig = vi.fn();
const mockListDevices = vi.fn();
const mockRemoveDevice = vi.fn();
const mockSendTest = vi.fn();
const mockEnable = vi.fn();
const mockDisable = vi.fn();
const mockCurrentFingerprint = vi.fn();
const mockGetPushSupport = vi.fn();
const mockIsInstalledIosWebApp = vi.fn();

vi.mock('@/lib/push', () => ({
  pushApi: {
    getConfig: () => mockGetConfig(),
    listDevices: () => mockListDevices(),

    removeDevice: (...args: any[]) => mockRemoveDevice(...args),
    sendTest: () => mockSendTest(),
  },

  enablePushOnThisDevice: (...args: any[]) => mockEnable(...args),

  disablePushOnThisDevice: (...args: any[]) => mockDisable(...args),
  currentDeviceFingerprint: () => mockCurrentFingerprint(),
  getPushSupport: () => mockGetPushSupport(),
  isInstalledIosWebApp: () => mockIsInstalledIosWebApp(),
  // Declared inside the factory: `vi.mock` is hoisted above every top-level
  // binding in this file, so a class defined outside it is not yet initialised
  // when the factory runs.
  PushPermissionError: class extends Error {
    constructor(readonly reason: 'denied' | 'dismissed') {
      super('permission');
      this.name = 'PushPermissionError';
    }
  },
}));

const THIS_DEVICE = 'aaaabbbbccccdddd';
const OTHER_DEVICE = '1111222233334444';

function device(overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    id: 'd-1',
    endpointFingerprint: THIS_DEVICE,
    deviceName: 'Chrome on Linux',
    userAgent: 'Mozilla/5.0',
    createdAt: '2026-08-01T10:00:00.000Z',
    lastSeenAt: '2026-08-02T10:00:00.000Z',
    lastSuccessAt: null,
    disabledAt: null,
    disabledReason: null,
    ...overrides,
  };
}

describe('PushDevicesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue({
      enabled: true,
      publicKey: 'PUB',
      configured: true,
      keyUnreadable: false,
    });
    mockListDevices.mockResolvedValue([]);
    mockCurrentFingerprint.mockResolvedValue(null);
    mockGetPushSupport.mockReturnValue({ supported: true });
    mockIsInstalledIosWebApp.mockReturnValue(false);
    mockEnable.mockResolvedValue(device());
    mockSendTest.mockResolvedValue({ attempted: 1, delivered: 1, devices: [] });
  });

  it('offers to enable push on this device', async () => {
    render(<PushDevicesPanel />);

    expect(
      await screen.findByRole('button', { name: /enable on this device/i }),
    ).toBeInTheDocument();
  });

  // A test send with nothing registered would report success over nothing.
  it('disables the test button until a live device exists', async () => {
    render(<PushDevicesPanel />);

    const button = await screen.findByRole('button', {
      name: /send test notification/i,
    });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/No device is registered yet/i),
    ).toBeInTheDocument();
  });

  it('marks the row that is this browser', async () => {
    mockListDevices.mockResolvedValue([
      device(),
      device({
        id: 'd-2',
        endpointFingerprint: OTHER_DEVICE,
        deviceName: 'Safari on iOS',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText('Chrome on Linux');
    expect(screen.getByText('This device')).toBeInTheDocument();
    // The other device is listed, and is not claimed to be this one.
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.getAllByText('This device')).toHaveLength(1);
  });

  // The regression: a retired row is not a registration. After a rotation the
  // device is listed with the copy telling the user to enable push again, and
  // hiding the button on the strength of that row left them with the
  // instruction and no way to follow it.
  it('offers the enable button again once this browser is retired', async () => {
    mockListDevices.mockResolvedValue([
      device({
        disabledAt: '2026-08-03T10:00:00.000Z',
        disabledReason: 'KEY_ROTATED',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText(/rotated its push key pair/i);
    expect(
      screen.getByRole('button', { name: /enable on this device/i }),
    ).toBeInTheDocument();
  });

  it('hides the enable button once this browser is registered', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText('Chrome on Linux');
    expect(
      screen.queryByRole('button', { name: /enable on this device/i }),
    ).not.toBeInTheDocument();
  });

  // The whole point of the reason column: each of the three needs a different
  // repair, and "unavailable" with no cause is a dead end.
  it.each([
    ['GONE', /No longer reachable/i],
    ['KEY_ROTATED', /rotated its push key pair/i],
    ['FAILING', /repeated delivery failures/i],
  ])(
    'says why a device disabled with %s stopped working',
    async (reason, copy) => {
      mockListDevices.mockResolvedValue([
        device({
          disabledAt: '2026-08-03T10:00:00.000Z',
          disabledReason: reason as PushDevice['disabledReason'],
        }),
      ]);

      render(<PushDevicesPanel />);

      expect(await screen.findByText(copy)).toBeInTheDocument();
    },
  );

  // Three reasons push can be unavailable, three repairs, three messages. The
  // one that matters most is the middle: a key pair the server cannot read is
  // not an administrator's decision, and saying it is sends the reader to ask
  // somebody who has nothing to change.
  it.each([
    [
      'an administrator switched it off',
      {
        enabled: false,
        publicKey: 'PUB',
        configured: true,
        keyUnreadable: false,
      },
      /administrator has switched browser push off/i,
    ],
    [
      'the instance has no key pair',
      {
        enabled: false,
        publicKey: null,
        configured: false,
        keyUnreadable: false,
      },
      /not available on this Monize instance/i,
    ],
    [
      'the key pair cannot be read',
      {
        enabled: false,
        publicKey: 'PUB',
        configured: true,
        keyUnreadable: true,
      },
      /cannot read this instance's push key pair/i,
    ],
  ])('says so in its own words when %s', async (_name, config, copy) => {
    mockGetConfig.mockResolvedValue(config);

    render(<PushDevicesPanel />);

    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  // A failed read is not "push is off here": that message sends the user to ask
  // an administrator about a switch that may well be on.
  // Two failures, two questions. A device list that will not load says nothing
  // about whether push is available here, and folding them together hid a
  // working Enable button behind "we could not check".
  it('keeps the enable button when only the device list fails', async () => {
    mockListDevices.mockRejectedValue(new Error('boom'));

    render(<PushDevicesPanel />);

    expect(
      await screen.findByText(/could not load your registered devices/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /enable on this device/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/could not check whether browser push is available/i),
    ).not.toBeInTheDocument();
  });

  it('says the status could not be read when the request fails', async () => {
    mockGetConfig.mockRejectedValue(new Error('boom'));

    render(<PushDevicesPanel />);

    expect(
      await screen.findByText(
        /could not check whether browser push is available/i,
      ),
    ).toBeInTheDocument();
    expect(mockListDevices).not.toHaveBeenCalled();
  });

  it('tells an iPhone user to install the app rather than that it cannot work', async () => {
    mockGetPushSupport.mockReturnValue({
      supported: false,
      reason: 'ios-browser',
    });

    render(<PushDevicesPanel />);

    expect(await screen.findByText(/Add to Home Screen/i)).toBeInTheDocument();
  });

  // A browser that cannot receive push is still the browser somebody is sitting
  // at when they want to revoke a device registered on another machine.
  it('still lists and can remove devices on a browser that cannot receive push', async () => {
    mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });
    mockListDevices.mockResolvedValue([
      device({
        id: 'd-2',
        endpointFingerprint: OTHER_DEVICE,
        deviceName: 'Safari on iOS',
      }),
    ]);
    mockRemoveDevice.mockResolvedValue(undefined);

    render(<PushDevicesPanel />);

    expect(await screen.findByText('Safari on iOS')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /enable on this device/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(mockRemoveDevice).toHaveBeenCalledWith('d-2'));
  });

  it('explains a blocked permission as a browser setting to change', async () => {
    mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });

    render(<PushDevicesPanel />);

    expect(
      await screen.findByText(/blocked for Monize in this browser/i),
    ).toBeInTheDocument();
  });

  it('registers this device with the instance public key', async () => {
    render(<PushDevicesPanel />);

    fireEvent.click(
      await screen.findByRole('button', { name: /enable on this device/i }),
    );

    await waitFor(() => expect(mockEnable).toHaveBeenCalled());
    // The key comes from the instance config, never from a literal here. The
    // device name is a suggestion and may legitimately be absent.
    expect(mockEnable.mock.calls[0][0]).toBe('PUB');
    // The list is re-read from the server rather than patched from the response.
    expect(mockListDevices).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['denied', /blocking notifications for Monize/i],
    ['dismissed', /Choose Allow when the browser asks/i],
  ])('reports a %s permission in its own words', async (reason, expected) => {
    mockEnable.mockRejectedValue(
      new PushPermissionError(reason as 'denied' | 'dismissed'),
    );

    render(<PushDevicesPanel />);

    fireEvent.click(
      await screen.findByRole('button', { name: /enable on this device/i }),
    );

    // The message itself, not merely that the attempt was made: the two
    // refusals send the user to different places, and a test that stops at
    // the call cannot tell them apart.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(expected as RegExp),
      ),
    );
  });

  describe('a subscription the server has never seen', () => {
    // The push service rotated it while the app was closed, so the worker's
    // message reached no window: the browser holds an endpoint the server has
    // never seen, and the list showed the dead row as active.
    it('re-registers it without asking, because consent already exists', async () => {
      vi.stubGlobal('Notification', { permission: 'granted' });
      mockListDevices.mockResolvedValue([
        device({ id: 'stale', endpointFingerprint: OTHER_DEVICE }),
      ]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      // The instance key, and whatever name this agent yields -- which is
      // `undefined` for an agent `defaultDeviceName` does not recognise, so the
      // argument is read rather than matched with `expect.anything()`.
      await waitFor(() => expect(mockEnable).toHaveBeenCalled());
      expect(mockEnable.mock.calls[0][0]).toBe('PUB');
      // And the list is re-read, so the row the user sees is the new one.
      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(2));
      vi.unstubAllGlobals();
    });

    it('leaves a browser whose subscription is already registered alone', async () => {
      vi.stubGlobal('Notification', { permission: 'granted' });
      mockListDevices.mockResolvedValue([device()]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      await waitFor(() => expect(mockListDevices).toHaveBeenCalled());
      expect(mockEnable).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    // Re-registering is a re-registration of something consented to. Without a
    // grant it would be a permission request with no user gesture behind it,
    // which iOS answers `default` with no prompt shown -- and the user would be
    // told their permission was refused for something they never asked for.
    it('does not touch a browser that has not granted permission', async () => {
      vi.stubGlobal('Notification', { permission: 'default' });
      mockListDevices.mockResolvedValue([
        device({ id: 'stale', endpointFingerprint: OTHER_DEVICE }),
      ]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      await waitFor(() => expect(mockListDevices).toHaveBeenCalled());
      expect(mockEnable).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not touch a browser holding no subscription at all', async () => {
      vi.stubGlobal('Notification', { permission: 'granted' });
      mockListDevices.mockResolvedValue([]);
      mockCurrentFingerprint.mockResolvedValue(null);

      render(<PushDevicesPanel />);

      await waitFor(() => expect(mockListDevices).toHaveBeenCalled());
      expect(mockEnable).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  // A prompt that never appears is what an installed iOS web app does when the
  // click's user activation has been spent -- and it reaches the app as the
  // same 'dismissed' the user gets for closing a dialogue. Telling that user to
  // "choose Allow when the browser asks" sends them to wait for a dialogue that
  // is not coming.
  it('tells an installed iOS web app what to do when no prompt appeared', async () => {
    mockIsInstalledIosWebApp.mockReturnValue(true);
    mockEnable.mockRejectedValue(new PushPermissionError('dismissed'));

    render(<PushDevicesPanel />);

    fireEvent.click(
      await screen.findByRole('button', { name: /enable on this device/i }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/If no prompt appeared/i),
      ),
    );
  });

  // The prompt only appears while the click's transient activation lasts, so
  // the registration has to START inside the handler. jsdom does not model user
  // activation, so this cannot prove the browser behaviour -- what it does
  // catch is the shape that loses it: an `await` placed before the call, which
  // is how a handler acquires a suspension point without anyone noticing.
  it('starts the permission request synchronously on the click', async () => {
    render(<PushDevicesPanel />);
    const button = await screen.findByRole('button', {
      name: /enable on this device/i,
    });

    mockEnable.mockClear();
    fireEvent.click(button);

    expect(mockEnable).toHaveBeenCalledTimes(1);
    // Let the handler's async tail land inside act.
    await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(2));
  });

  // Removing this browser's own device has to unsubscribe locally too, or the
  // browser keeps a permission the app no longer uses.
  // "Both halves, always" has to survive the first half failing: a browser
  // subscription with no server row is a permission the app holds, no longer
  // uses, and the user cannot see.
  it('still releases the browser subscription when the server delete fails', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);
    mockDisable.mockRejectedValue(new Error('server down'));

    render(<PushDevicesPanel />);
    await screen.findByText('Chrome on Linux');
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(mockDisable).toHaveBeenCalledWith('d-1'));
    // The panel reports the failure rather than pretending the device is gone.
    expect(await screen.findByText('Chrome on Linux')).toBeInTheDocument();
  });

  it('unsubscribes locally when removing this browser, not when removing another', async () => {
    mockListDevices.mockResolvedValue([
      device(),
      device({
        id: 'd-2',
        endpointFingerprint: OTHER_DEVICE,
        deviceName: 'Safari on iOS',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);
    mockDisable.mockResolvedValue(undefined);
    mockRemoveDevice.mockResolvedValue(undefined);

    render(<PushDevicesPanel />);
    await screen.findByText('Chrome on Linux');

    const [removeThis, removeOther] = screen.getAllByRole('button', {
      name: /remove/i,
    });

    fireEvent.click(removeThis);
    await waitFor(() => expect(mockDisable).toHaveBeenCalledWith('d-1'));
    expect(mockRemoveDevice).not.toHaveBeenCalled();

    fireEvent.click(removeOther);
    await waitFor(() => expect(mockRemoveDevice).toHaveBeenCalledWith('d-2'));
  });

  it('re-reads the device list after a test send, because a send can retire a device', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockSendTest.mockResolvedValue({
      attempted: 1,
      delivered: 0,
      devices: [{ id: 'd-1', deviceName: null, status: 'expired' }],
    });

    render(<PushDevicesPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: /send test notification/i }),
    );

    await waitFor(() => expect(mockSendTest).toHaveBeenCalled());
    expect(mockListDevices).toHaveBeenCalledTimes(2);
  });
});

describe('PushDevicesPanel and a browser-rotated subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue({
      enabled: true,
      publicKey: 'PUB',
      configured: true,
      keyUnreadable: false,
    });
    mockListDevices.mockResolvedValue([]);
    mockCurrentFingerprint.mockResolvedValue(null);
    mockGetPushSupport.mockReturnValue({ supported: true });
  });

  // The worker resubscribes and says so; this is the surface that holds the
  // session and the CSRF token, so it is the one that has to notice.
  it('re-reads the device list when the worker reports a rotation', async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (type: string, fn: EventListener) =>
          listeners.set(type, fn),
        removeEventListener: () => listeners.clear(),
      },
    });
    try {
      render(<PushDevicesPanel />);
      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(1));

      listeners.get('message')?.({
        data: { type: 'monize-push-subscription-changed' },
      } as unknown as Event);

      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(2));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores an unrelated worker message', async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (type: string, fn: EventListener) =>
          listeners.set(type, fn),
        removeEventListener: () => listeners.clear(),
      },
    });
    try {
      render(<PushDevicesPanel />);
      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(1));

      listeners.get('message')?.({
        data: { type: 'monize-offline-strings' },
      } as unknown as Event);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockListDevices).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('defaultDeviceName', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/605.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/121.0',
      'Firefox on Mac',
    ],
  ])('names %s as %s', (userAgent, expected) => {
    expect(defaultDeviceName({ userAgent } as Navigator)).toBe(expected);
  });

  it('offers no name rather than a wrong one for an unrecognised agent', () => {
    expect(defaultDeviceName({ userAgent: '' } as Navigator)).toBeUndefined();
    expect(
      defaultDeviceName({ userAgent: 'curl/8' } as Navigator),
    ).toBeUndefined();
  });
});
