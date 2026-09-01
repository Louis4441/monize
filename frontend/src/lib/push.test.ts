import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from './api';
import {
  ENDPOINT_FINGERPRINT_LENGTH,
  PushPermissionError,
  currentDeviceFingerprint,
  disablePushOnThisDevice,
  releaseLocalPushSubscription,
  releasePushForSignOut,
  SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS,
  ENDPOINT_CLAIMED_CODE,
  ServiceWorkerUnavailableError,
  SERVICE_WORKER_READY_TIMEOUT_MS,
  enablePushOnThisDevice,
  fingerprintEndpoint,
  getPushSupport,
  pushApi,
  toSubscriptionPayload,
  urlBase64ToUint8Array,
} from './push';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/abcdef';
// A real VAPID public key is 65 raw bytes as 87 base64url characters.
const PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkTtF4kzVfPYlLpTfLmXQNDSjEhBWIhkbBLPuLNKlP8fMKPXCkPvxKA';

describe('pushApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the instance configuration', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        enabled: true,
        publicKey: PUBLIC_KEY,
        configured: true,
        keyUnreadable: false,
      },
    });

    const config = await pushApi.getConfig();

    expect(apiClient.get).toHaveBeenCalledWith('/push/config');
    expect(config.enabled).toBe(true);
  });

  it('lists devices and posts a subscription without naming a user', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'd-1' } });

    await pushApi.listDevices();
    await pushApi.subscribe({
      endpoint: ENDPOINT,
      p256dh: 'p',
      auth: 'a',
      applicationServerKey: PUBLIC_KEY,
      deviceName: 'Pixel',
    });

    expect(apiClient.get).toHaveBeenCalledWith('/push/subscriptions');
    const [, payload] = vi.mocked(apiClient.post).mock.calls[0];
    // The owner is the JWT's, and there is no field here that could say otherwise.
    expect(Object.keys(payload as object).sort()).toEqual([
      'applicationServerKey',
      'auth',
      'deviceName',
      'endpoint',
      'p256dh',
    ]);
  });

  it('removes a device by id and sends a test', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { attempted: 1, delivered: 1, devices: [] },
    });

    await pushApi.removeDevice('d-1');
    await pushApi.sendTest();

    expect(apiClient.delete).toHaveBeenCalledWith('/push/subscriptions/d-1');
    expect(apiClient.post).toHaveBeenCalledWith('/push/test');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a VAPID public key to its 65 raw bytes', () => {
    const bytes = urlBase64ToUint8Array(PUBLIC_KEY);

    expect(bytes).toHaveLength(65);
    // An uncompressed P-256 point starts with 0x04.
    expect(bytes[0]).toBe(0x04);
    // Backed by a plain ArrayBuffer, which is what applicationServerKey needs.
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('handles the base64url alphabet and missing padding', () => {
    // '-' and '_' stand in for '+' and '/', and the server stores no '='.
    expect(urlBase64ToUint8Array('-_-_')).toEqual(
      new Uint8Array([0xfb, 0xff, 0xbf]),
    );
    expect(urlBase64ToUint8Array('AQ')).toEqual(new Uint8Array([0x01]));
  });
});

describe('toSubscriptionPayload', () => {
  it('flattens a browser subscription', () => {
    expect(
      toSubscriptionPayload({
        endpoint: ENDPOINT,
        keys: { p256dh: 'p', auth: 'a' },
      }),
    ).toEqual({ endpoint: ENDPOINT, p256dh: 'p', auth: 'a' });
  });

  // Half a subscription cannot be delivered to, so it is refused rather than
  // stored as a device the user believes works.
  it.each([
    ['no keys', { endpoint: ENDPOINT }],
    ['no endpoint', { keys: { p256dh: 'p', auth: 'a' } }],
    ['no auth', { endpoint: ENDPOINT, keys: { p256dh: 'p' } }],
    ['no p256dh', { endpoint: ENDPOINT, keys: { auth: 'a' } }],
  ])('refuses a subscription with %s', (_name, subscription) => {
    expect(
      toSubscriptionPayload(subscription as PushSubscriptionJSON),
    ).toBeNull();
  });
});

describe('getPushSupport', () => {
  interface SupportFixture {
    serviceWorker?: boolean;
    pushManager?: boolean;
    notification?: NotificationPermission | null;
    userAgent?: string;
    platform?: string;
    maxTouchPoints?: number;
    /** iOS Safari's own installed-app flag; absent on every other browser. */
    standalone?: boolean;
    displayModeStandalone?: boolean;
  }

  // Built as loose records rather than partial Window/Navigator: both declare
  // the properties under test as readonly, so a typed partial cannot express
  // "this browser does not have a PushManager at all", which is the whole
  // subject here.
  function build({
    serviceWorker = true,
    pushManager = true,
    notification = 'default',
    userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
    platform = 'Linux x86_64',
    maxTouchPoints = 0,
    standalone,
    displayModeStandalone = false,
  }: SupportFixture = {}) {
    const win: Record<string, unknown> = {
      matchMedia: () => ({ matches: displayModeStandalone }),
      navigator: { standalone },
    };
    if (pushManager) win.PushManager = class {};
    if (notification !== null) win.Notification = { permission: notification };
    const nav: Record<string, unknown> = {
      userAgent,
      platform,
      maxTouchPoints,
    };
    if (serviceWorker) nav.serviceWorker = {};
    return { win: win as unknown as Window, nav: nav as unknown as Navigator };
  }

  it('reports support on a capable browser that has not been asked yet', () => {
    const { win, nav } = build();

    expect(getPushSupport(win, nav)).toEqual({ supported: true });
  });

  // 'default' is where a first-time user is. Treating it as a failure would hide
  // the button whose whole job is to trigger the prompt.
  it('does not treat an unanswered permission prompt as a refusal', () => {
    const { win, nav } = build({ notification: 'default' });

    expect(getPushSupport(win, nav).supported).toBe(true);
  });

  it('separates a blocked permission from an incapable browser', () => {
    const denied = build({ notification: 'denied' });
    const incapable = build({ pushManager: false });

    expect(getPushSupport(denied.win, denied.nav)).toEqual({
      supported: false,
      reason: 'denied',
    });
    expect(getPushSupport(incapable.win, incapable.nav)).toEqual({
      supported: false,
      reason: 'unsupported',
    });
  });

  // The case that looks like a bug and is not: Safari delivers Web Push only to
  // a PWA installed on the Home Screen, so "unsupported" would send an iPhone
  // user away for good from a thing that works after one more step.
  it('names the installable case on an iPhone browser tab', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
      platform: 'iPhone',
    });

    expect(getPushSupport(win, nav)).toEqual({
      supported: false,
      reason: 'ios-browser',
    });
  });

  it('names the installable case on an iPad reporting itself as a Mac', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });

    expect(getPushSupport(win, nav).reason).toBe('ios-browser');
  });

  it('does not blame iOS once the app is installed', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
      platform: 'iPhone',
      standalone: true,
    });

    expect(getPushSupport(win, nav).reason).toBe('unsupported');
  });

  it('treats a standalone display mode as installed', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
      platform: 'iPhone',
      displayModeStandalone: true,
    });

    expect(getPushSupport(win, nav).reason).toBe('unsupported');
  });
});

describe('fingerprintEndpoint', () => {
  it('matches the prefix length the server publishes', async () => {
    const fingerprint = await fingerprintEndpoint(ENDPOINT);

    expect(fingerprint).toHaveLength(ENDPOINT_FINGERPRINT_LENGTH);
    expect(fingerprint).toMatch(/^[0-9a-f]+$/);
  });

  it('is stable for one endpoint and different for another', async () => {
    const [a, b, c] = await Promise.all([
      fingerprintEndpoint(ENDPOINT),
      fingerprintEndpoint(ENDPOINT),
      fingerprintEndpoint(`${ENDPOINT}x`),
    ]);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('enabling and disabling push on this device', () => {
  let subscribe: ReturnType<typeof vi.fn>;
  let getSubscription: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let requestPermission: ReturnType<typeof vi.fn>;

  function browserSubscription(applicationServerKey?: ArrayBuffer) {
    return {
      endpoint: ENDPOINT,
      options: { applicationServerKey: applicationServerKey ?? null },
      unsubscribe,
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribe = vi.fn(async () => true);
    getSubscription = vi.fn(async () => null);
    subscribe = vi.fn(async () => browserSubscription());
    requestPermission = vi.fn(async () => 'granted' as NotificationPermission);

    vi.stubGlobal('Notification', { requestPermission, permission: 'default' });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }),
      },
    });
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'd-1' } });
    vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('asks for permission, then registers, and reports the stored device', async () => {
    const device = await enablePushOnThisDevice(PUBLIC_KEY, 'Pixel 9');

    // The key the browser actually used travels with the registration: the
    // server checks it is still current rather than stamping its own value over
    // a subscription minted under a superseded pair.
    expect(vi.mocked(apiClient.post).mock.calls[0][1]).toMatchObject({
      applicationServerKey: PUBLIC_KEY,
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY),
    });
    expect(device.id).toBe('d-1');
  });

  // 'denied' and 'dismissed' need different words: the first is a decision only
  // the user can undo in site settings, the second is "ask me again".
  it.each([
    ['denied', 'denied'],
    ['default', 'dismissed'],
  ])(
    'reports a %s permission as %s without subscribing',
    async (permission, reason) => {
      requestPermission.mockResolvedValue(permission as NotificationPermission);

      await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toMatchObject({
        name: 'PushPermissionError',
        reason,
      });
      expect(subscribe).not.toHaveBeenCalled();
      expect(apiClient.post).not.toHaveBeenCalled();
    },
  );

  it('reuses a subscription already minted under the current key', async () => {
    const current = urlBase64ToUint8Array(PUBLIC_KEY);
    getSubscription.mockResolvedValue(browserSubscription(current.buffer));

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalled();
  });

  // After an instance rotates its key pair the browser still holds the old
  // subscription, and every message signed with the new key would be rejected.
  it('replaces a subscription minted under a superseded key', async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(new Uint8Array([1, 2, 3]).buffer),
    );

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('replaces a subscription whose key the browser will not disclose', async () => {
    getSubscription.mockResolvedValue(browserSubscription(undefined));

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('refuses an incomplete subscription rather than storing a dead device', async () => {
    subscribe.mockResolvedValue({
      endpoint: ENDPOINT,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint: ENDPOINT, keys: {} }),
    });

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow(
      /incomplete push subscription/,
    );
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  // Both halves, always: a server row without a browser subscription is a
  // device the user cannot receive on, and the reverse is a permission the app
  // holds and no longer uses.
  it('removes the server row and the browser subscription together', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await disablePushOnThisDevice('d-1');

    expect(apiClient.delete).toHaveBeenCalledWith('/push/subscriptions/d-1');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // A refusal that is not a stale claim -- the per-account cap, a rotated key, a
  // 500 -- must not leave a browser subscription with no server row behind it:
  // a permission this app holds, no longer uses, and the user cannot see.
  it('takes back a subscription it minted when the registration is refused', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('too many devices'), {
        response: { status: 400 },
      }),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow(
      'too many devices',
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // ...but one the browser already had may back a perfectly good row, so a
  // failure here is not licence to drop it.
  it('leaves a pre-existing subscription alone when the registration is refused', async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('boom'), { response: { status: 500 } }),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow('boom');

    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('takes back the replacement too when the retry is refused', async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('conflict'), {
        response: { status: 409, data: { errorCode: ENDPOINT_CLAIMED_CODE } },
      }),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow(
      'conflict',
    );

    // One for the stale claim, one taking the replacement back.
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  // Deleting the server row needs the session that is ending, so this runs
  // before the cookies are cleared -- and under its own short bound, because
  // the cleanup is best effort and revoking the session is not.
  it("removes this browser's server row and subscription on sign-out", async () => {
    getSubscription.mockResolvedValue(browserSubscription());
    const fingerprint = await fingerprintEndpoint(ENDPOINT);
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        { id: 'd-other', endpointFingerprint: '0000000000000000' },
        { id: 'd-1', endpointFingerprint: fingerprint },
      ],
    });

    await releasePushForSignOut();

    expect(apiClient.delete).toHaveBeenCalledWith('/push/subscriptions/d-1');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('still unsubscribes locally when the row cannot be removed', async () => {
    getSubscription.mockResolvedValue(browserSubscription());
    vi.mocked(apiClient.get).mockRejectedValue(new Error('401'));

    await expect(releasePushForSignOut()).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than holding a sign-out open', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: new Promise<never>(() => {}) },
    });
    try {
      const pending = releasePushForSignOut();
      await vi.advanceTimersByTimeAsync(SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the browser subscription even when the server delete fails', async () => {
    getSubscription.mockResolvedValue(browserSubscription());
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('server down'));

    await expect(disablePushOnThisDevice('d-1')).rejects.toThrow('server down');

    // The failure propagates -- the row may well still be there -- but the
    // local half runs regardless, because a browser subscription with no server
    // row is a permission the app holds and the user cannot see.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('still unsubscribes in the browser when there is no server row to remove', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await disablePushOnThisDevice();

    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports no current device when the browser holds no subscription', async () => {
    await expect(currentDeviceFingerprint()).resolves.toBeNull();
  });

  it('reports the current device as the same digest the server publishes', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await expect(currentDeviceFingerprint()).resolves.toBe(
      await fingerprintEndpoint(ENDPOINT),
    );
  });

  // The server refuses to take an endpoint over from another account -- an
  // endpoint is a string the client supplied, not proof of ownership -- so the
  // repair belongs here: drop the stale subscription and mint a fresh endpoint
  // nobody holds.
  it('recovers from a claimed endpoint by subscribing again', async () => {
    const claimed = Object.assign(new Error('conflict'), {
      response: { status: 409, data: { errorCode: ENDPOINT_CLAIMED_CODE } },
    });
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce(claimed)
      .mockResolvedValueOnce({ data: { id: 'd-2' } });
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );

    const device = await enablePushOnThisDevice(PUBLIC_KEY);

    // One unsubscribe and one subscribe, both caused by the 409 rather than by
    // a key mismatch: the browser held a subscription minted under this very
    // key, so nothing before the POST had any reason to replace it.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(device.id).toBe('d-2');
  });

  // A second 409 on a brand-new endpoint means something other than a stale
  // claim, so it surfaces instead of looping.
  it('retries a claimed endpoint exactly once', async () => {
    const claimed = Object.assign(new Error('conflict'), {
      response: { status: 409, data: { errorCode: ENDPOINT_CLAIMED_CODE } },
    });
    vi.mocked(apiClient.post).mockRejectedValue(claimed);
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toBe(claimed);
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  // The key-rotation refusal is also a 409, and recovering from it by
  // unsubscribing would destroy a working registration and retry with the same
  // stale key. Branching on the status alone was exactly that bug.
  it.each([
    ['a plain 400', { status: 400 }],
    ['a plain 403', { status: 403 }],
    ['a 500', { status: 500 }],
    ['a 409 that is not a claimed endpoint', { status: 409 }],
    [
      'a 409 carrying some other code',
      { status: 409, data: { errorCode: 'somethingElse' } },
    ],
  ])('does not re-subscribe on %s', async (_name, response) => {
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('nope'), { response }),
    );
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow('nope');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  // Logout's half: the subscription is scoped to the origin, not the session,
  // so leaving it registered keeps delivering the departing account's
  // notifications onto a browser the next person is using.
  it('releases the local subscription without deleting any server row', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await releaseLocalPushSubscription();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it('never throws while releasing, so a logout cannot fail on the push channel', async () => {
    getSubscription.mockRejectedValue(new Error('service worker gone'));

    await expect(releaseLocalPushSubscription()).resolves.toBeUndefined();
  });

  // `navigator.serviceWorker.ready` never rejects, so an unbounded await on a
  // worker that never installs leaves the whole push block stuck in its loading
  // state -- it simply disappears from Settings, with no error anywhere.
  it('gives up on a service worker that never becomes ready', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: new Promise<never>(() => {}) },
    });
    try {
      const pending = enablePushOnThisDevice(PUBLIC_KEY);
      const assertion = expect(pending).rejects.toThrow(
        ServiceWorkerUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(SERVICE_WORKER_READY_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the permission refusal as a named error class', () => {
    const error = new PushPermissionError('denied');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PushPermissionError');
  });
});
