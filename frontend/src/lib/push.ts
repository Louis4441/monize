import apiClient from './api';
import { getErrorCode } from './errors';

/** Why a device stopped being reachable. Mirrors the backend enum. */
export type PushDisabledReason = 'GONE' | 'KEY_ROTATED' | 'FAILING';

export interface PushDevice {
  id: string;
  /**
   * A prefix of the endpoint's SHA-256, so this browser can recognise which row
   * is itself. The endpoint is a delivery credential and never leaves the
   * server, so the list carries a digest instead.
   */
  endpointFingerprint: string;
  deviceName: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  lastSuccessAt: string | null;
  disabledAt: string | null;
  disabledReason: PushDisabledReason | null;
}

export interface PushConfig {
  /**
   * All three: the instance holds a key pair, that key pair can still be used,
   * and an administrator has left the channel on.
   */
  enabled: boolean;
  publicKey: string | null;
  /** False when the server has no key pair at all, so the UI can say which. */
  configured: boolean;
  /**
   * A stored key pair the server can no longer decrypt. Its own state, because
   * the repair differs from every other reason push is unavailable -- and
   * without it this surface told users an administrator had switched push off,
   * which is false and sends them to the wrong person.
   */
  keyUnreadable: boolean;
}

export type PushTestStatus = 'sent' | 'unconfigured' | 'expired' | 'transient';

export interface PushTestDeviceResult {
  id: string;
  deviceName: string | null;
  status: PushTestStatus;
  disabledReason?: PushDisabledReason;
}

export interface PushTestResult {
  attempted: number;
  delivered: number;
  devices: PushTestDeviceResult[];
}

export const pushApi = {
  getConfig: async (): Promise<PushConfig> => {
    const response = await apiClient.get<PushConfig>('/push/config');
    return response.data;
  },

  listDevices: async (): Promise<PushDevice[]> => {
    const response = await apiClient.get<PushDevice[]>('/push/subscriptions');
    return response.data;
  },

  subscribe: async (payload: {
    endpoint: string;
    p256dh: string;
    auth: string;
    /** The key the browser subscribed with, which the server checks is current. */
    applicationServerKey: string;
    deviceName?: string;
  }): Promise<PushDevice> => {
    const response = await apiClient.post<PushDevice>(
      '/push/subscriptions',
      payload,
    );
    return response.data;
  },

  removeDevice: async (id: string): Promise<void> => {
    await apiClient.delete(`/push/subscriptions/${id}`);
  },

  sendTest: async (): Promise<PushTestResult> => {
    const response = await apiClient.post<PushTestResult>('/push/test');
    return response.data;
  },
};

/**
 * Why this browser cannot register for push, when it cannot.
 *
 * `unsupported` and `denied` need different words from the user's side: the
 * first is a browser that will never do this, the second is a decision the user
 * made and can undo in site settings. `ios-browser` is the one that looks like a
 * bug and is not -- Safari delivers Web Push only to a PWA installed on the home
 * screen (iOS 16.4+), so the repair is "Add to Home Screen", not "try again".
 */
export type PushUnavailableReason = 'unsupported' | 'denied' | 'ios-browser';

export interface PushSupport {
  supported: boolean;
  reason?: PushUnavailableReason;
}

function isIos(nav: Navigator): boolean {
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch points are what give it away.
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  );
}

function isStandalone(win: Window): boolean {
  const iosStandalone = (win.navigator as Navigator & { standalone?: boolean })
    .standalone;
  return (
    iosStandalone === true ||
    win.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

/**
 * Whether this browser can register for push, and why not when it cannot.
 *
 * Deliberately does NOT read `Notification.permission === 'default'` as a
 * failure: that is the state a first-time user is in, and the whole point of the
 * permission flow is that the prompt appears when they ask for it.
 */
export function getPushSupport(
  win: Window = window,
  nav: Navigator = navigator,
): PushSupport {
  // Read through a typed accessor rather than `in` narrowing: an `in` check
  // rewrites the parameter's type to an intersection, and the next property read
  // then fails to compile for a reason that has nothing to do with the runtime.
  const notification = (win as Window & { Notification?: typeof Notification })
    .Notification;

  if (
    !('serviceWorker' in nav) ||
    !('PushManager' in win) ||
    notification === undefined
  ) {
    // On iOS the missing PushManager is not a permanent verdict about the
    // browser -- it is a verdict about this *window*, and installing the app
    // changes it. Saying "unsupported" would send the user away for good.
    return {
      supported: false,
      reason: isIos(nav) && !isStandalone(win) ? 'ios-browser' : 'unsupported',
    };
  }
  if (notification.permission === 'denied') {
    return { supported: false, reason: 'denied' };
  }
  return { supported: true };
}

/**
 * The applicationServerKey `pushManager.subscribe` wants: the VAPID public key,
 * base64url as the server stores it, as raw bytes.
 */
export function urlBase64ToUint8Array(
  base64UrlKey: string,
): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64UrlKey.length % 4)) % 4);
  const base64 = (base64UrlKey + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Backed by an explicit ArrayBuffer, not the default ArrayBufferLike: the
  // Push API's applicationServerKey takes a BufferSource, which a possibly-shared
  // buffer does not satisfy.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** A browser subscription flattened into what the API accepts. */
export function toSubscriptionPayload(
  subscription: PushSubscriptionJSON,
): { endpoint: string; p256dh: string; auth: string } | null {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return null;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/**
 * How long to wait for the service worker before giving up on it.
 *
 * `navigator.serviceWorker.ready` never rejects: a worker that fails to install
 * -- `/sw.js` misserved behind a proxy, say -- leaves the promise pending for
 * the life of the page. Awaited unbounded it takes the whole push block down
 * with it: the settings panel never leaves its loading state and simply
 * vanishes, and Enable and Remove hang with no error.
 */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 5000;

/** Thrown when the service worker never became ready, so callers can say so. */
export class ServiceWorkerUnavailableError extends Error {
  constructor() {
    super('The Monize service worker is not available in this browser.');
    this.name = 'ServiceWorkerUnavailableError';
  }
}

/** `navigator.serviceWorker.ready` with a bound, because it has none of its own. */
export async function serviceWorkerReady(
  timeoutMs = SERVICE_WORKER_READY_TIMEOUT_MS,
): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ServiceWorkerUnavailableError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Thrown when the browser refuses, so the caller can tell the user which refusal. */
export class PushPermissionError extends Error {
  constructor(readonly reason: 'denied' | 'dismissed') {
    super(`Notification permission ${reason}`);
    this.name = 'PushPermissionError';
  }
}

/**
 * Ask the browser for permission and register this device.
 *
 * The permission request is made here, on a user's click, and never on page
 * load: a prompt that arrives before anyone has asked for notifications is the
 * one users answer with "Block", and `denied` is not something the app can undo.
 *
 * Re-uses an existing browser subscription when there is one, and replaces it
 * when it was minted under a different key -- after an instance rotates its key
 * pair the old subscription still exists in the browser and is undeliverable.
 *
 * A 409 means the endpoint this browser holds is registered to a different
 * account (someone whose session ended without a logout). The server refuses to
 * take it over -- an endpoint is not proof of ownership -- so the repair is
 * here: unsubscribe and subscribe again, which mints a fresh endpoint nobody
 * holds. Exactly one retry, because a second 409 on a brand-new endpoint would
 * mean something other than a stale claim.
 */
export async function enablePushOnThisDevice(
  publicKey: string,
  deviceName?: string,
): Promise<PushDevice> {
  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw new PushPermissionError('denied');
  if (permission !== 'granted') throw new PushPermissionError('dismissed');

  const registration = await serviceWorkerReady();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription &&
    !keyMatches(
      subscription.options?.applicationServerKey,
      applicationServerKey,
    )
  ) {
    // Minted under a superseded key pair: the push service would reject every
    // message signed with the current one, so the stale subscription is dropped
    // rather than re-registered.
    await subscription.unsubscribe();
    subscription = null;
  }
  // Whether THIS call minted the subscription: only then is dropping it on a
  // failure the right cleanup. A subscription the browser already had may well
  // belong to a row that is perfectly fine.
  let minted = false;
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    minted = true;
  }

  try {
    return await postSubscription(subscription, publicKey, deviceName);
  } catch (error) {
    if (!isEndpointClaimed(error)) {
      // Any other refusal -- the per-account device cap, a rotated key, a 500 --
      // leaves a browser subscription with no server row behind it: a
      // permission this app holds, no longer uses, and the user cannot see. If
      // this call is what minted it, this call takes it back.
      if (minted) await safeUnsubscribe(subscription);
      throw error;
    }
    await subscription.unsubscribe();
    const replacement = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    try {
      return await postSubscription(replacement, publicKey, deviceName);
    } catch (retryError) {
      await safeUnsubscribe(replacement);
      throw retryError;
    }
  }
}

/** Unsubscribing is cleanup, so its own failure must not replace the real one. */
async function safeUnsubscribe(subscription: PushSubscription): Promise<void> {
  try {
    await subscription.unsubscribe();
  } catch {
    // Best effort.
  }
}

function postSubscription(
  subscription: PushSubscription,
  applicationServerKey: string,
  deviceName?: string,
): Promise<PushDevice> {
  const payload = toSubscriptionPayload(subscription.toJSON());
  if (!payload) {
    throw new Error('The browser returned an incomplete push subscription.');
  }
  return pushApi.subscribe({ ...payload, applicationServerKey, deviceName });
}

/** Matches `ENDPOINT_CLAIMED_CODE` in the backend's push subscription service. */
export const ENDPOINT_CLAIMED_CODE = 'pushEndpointClaimed';

/**
 * This endpoint belongs to someone else -- and only that.
 *
 * Deliberately not "any 409": a key rotation between page load and click is
 * also a 409, and answering it by unsubscribing would destroy a working
 * registration and then retry with the same stale key, guaranteed to fail. The
 * server ships a machine-readable code for exactly this branch.
 */
function isEndpointClaimed(error: unknown): boolean {
  return getErrorCode(error) === ENDPOINT_CLAIMED_CODE;
}

function keyMatches(
  stored: ArrayBuffer | null | undefined,
  wanted: Uint8Array,
): boolean {
  if (!stored) return false;
  const bytes = new Uint8Array(stored);
  if (bytes.length !== wanted.length) return false;
  return bytes.every((byte, index) => byte === wanted[index]);
}

/**
 * Remove this device: unsubscribe in the browser AND delete the server row.
 *
 * Both halves, always. A server row without a browser subscription is a device
 * the user cannot receive on; a browser subscription without a server row is a
 * permission the app has and no longer uses.
 */
export async function disablePushOnThisDevice(
  deviceId?: string,
): Promise<void> {
  try {
    if (deviceId) await pushApi.removeDevice(deviceId);
  } finally {
    // "Both halves, always" has to survive the first half failing. A browser
    // subscription with no server row is a permission the app holds and no
    // longer uses, and the user has no way to see it; the reverse self-heals on
    // the next delivery's 410.
    await releaseLocalPushSubscription();
  }
}

/**
 * Drop this browser's push subscription without touching any server row.
 *
 * What logout needs: the subscription is scoped to the origin rather than to
 * the session, so leaving it registered keeps delivering the departing
 * account's notifications onto a browser the next person is using, and holds
 * the endpoint against their own subscribe. The server row is deliberately left
 * alone -- it belongs to the account that is leaving, and its next delivery
 * answers 410 and retires it.
 *
 * Never throws: a logout that fails on the push channel is worse than a
 * subscription that outlives it.
 */
export async function releaseLocalPushSubscription(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const registration = await serviceWorkerReady();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    // Best effort.
  }
}

/**
 * The same digest prefix the server puts on every device row, computed from this
 * browser's own endpoint -- which is how a row is recognised as "this device"
 * without the endpoint ever being sent back.
 */
export async function fingerprintEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(endpoint),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, ENDPOINT_FINGERPRINT_LENGTH);
}

/** Matches ENDPOINT_FINGERPRINT_LENGTH in the backend's push subscription service. */
export const ENDPOINT_FINGERPRINT_LENGTH = 16;

/**
 * The digest of the endpoint this browser currently holds, or null when it holds
 * none. What "this device" means on the settings page.
 */
export async function currentDeviceFingerprint(): Promise<string | null> {
  const endpoint = await currentEndpoint();
  return endpoint ? fingerprintEndpoint(endpoint) : null;
}

/**
 * How long a sign-out will wait for the push cleanup before moving on.
 *
 * The cleanup is best effort and the session revocation is not, so the two must
 * not share a deadline: awaiting the service worker's own 5-second bound here
 * would stall the sign-out that long, and a tab closed in that window would
 * never revoke its session at all.
 */
export const SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS = 1500;

/**
 * Release this browser's push registration on the way out of a session: the
 * server row AND the browser subscription.
 *
 * Both halves, and the server half is why this cannot wait until after the
 * cookies are cleared -- deleting the row needs the session that is ending.
 * Without it the row stays live, looks healthy in the device list, and counts
 * against the per-account cap while nothing will ever be delivered to it: the
 * 410 that would retire it only arrives when something tries to send.
 *
 * Never throws, and never waits long: whatever has not finished when the bound
 * elapses is abandoned rather than allowed to hold up the sign-out.
 */
export async function releasePushForSignOut(
  timeoutMs = SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      removeThisBrowsersRegistration(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Best effort.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function removeThisBrowsersRegistration(): Promise<void> {
  try {
    const fingerprint = await currentDeviceFingerprint();
    if (fingerprint) {
      const mine = (await pushApi.listDevices()).find(
        (device) => device.endpointFingerprint === fingerprint,
      );
      if (mine) await pushApi.removeDevice(mine.id);
    }
  } catch {
    // The row may outlive the browser subscription; the local half below is
    // what actually stops notifications appearing, so it runs either way.
  }
  await releaseLocalPushSubscription();
}

/** The endpoint this browser currently holds, or null. */
export async function currentEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await serviceWorkerReady();
  const subscription = await registration.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}
