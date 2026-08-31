import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import { PushDevicesPanel, defaultDeviceName } from './PushDevicesPanel';
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
    });
    mockListDevices.mockResolvedValue([]);
    mockCurrentFingerprint.mockResolvedValue(null);
    mockGetPushSupport.mockReturnValue({ supported: true });
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

  it('separates an administrator switching push off from an unconfigured instance', async () => {
    mockGetConfig.mockResolvedValue({
      enabled: false,
      publicKey: 'PUB',
      configured: true,
    });
    const { unmount } = render(<PushDevicesPanel />);
    expect(
      await screen.findByText(/administrator has switched browser push off/i),
    ).toBeInTheDocument();
    unmount();

    mockGetConfig.mockResolvedValue({
      enabled: false,
      publicKey: null,
      configured: false,
    });
    render(<PushDevicesPanel />);
    expect(
      await screen.findByText(/not available on this Monize instance/i),
    ).toBeInTheDocument();
  });

  // A failed read is not "push is off here": that message sends the user to ask
  // an administrator about a switch that may well be on.
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
  ])('reports a %s permission in its own words', async (reason) => {
    mockEnable.mockRejectedValue(
      new PushPermissionError(reason as 'denied' | 'dismissed'),
    );

    render(<PushDevicesPanel />);

    fireEvent.click(
      await screen.findByRole('button', { name: /enable on this device/i }),
    );

    await waitFor(() => expect(mockEnable).toHaveBeenCalled());
  });

  // Removing this browser's own device has to unsubscribe locally too, or the
  // browser keeps a permission the app no longer uses.
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
