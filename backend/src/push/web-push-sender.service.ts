import { Injectable, Logger } from "@nestjs/common";
import * as webpush from "web-push";
import { PushConfigService, VAPID_SUBJECT } from "./push-config.service";
import { PushDisabledReason } from "./entities/push-subscription.entity";

/**
 * How long the push service should hold a message for a device that is offline.
 * Four hours: long enough to survive a night-time phone in a drawer, short
 * enough that a reminder does not arrive after the thing it reminds about.
 */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

/**
 * Consecutive transient failures a device may accumulate before it is retired.
 *
 * "Bounded retry" needs a bound, and this is it: the counter is reset by a
 * success, so a device that works occasionally never reaches it, while one that
 * has silently gone away stops being attempted rather than being retried
 * forever.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * The minimal shape a delivery needs. Deliberately not the entity: the sender
 * must not be able to reach a field it has no business reading.
 */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidPublicKey: string;
}

/**
 * What crosses the push service, and therefore what may end up on a lock
 * screen. Privacy-minimal by construction: no amount, no account name, no payee
 * -- the body is composed from the recipient's own locale on the server and the
 * detail loads once the app is open (discussion #1291, "privacy by default").
 */
export interface PushPayload {
  type: string;
  title: string;
  body: string;
  /** Same-origin path the click should open. Validated again in the worker. */
  target?: string;
  notificationId?: string;
}

export type PushSendOutcome =
  /** Accepted by the push service. */
  | { status: "sent" }
  /** The instance has no usable key pair, or the channel is switched off. */
  | { status: "unconfigured" }
  /** Permanently unusable; `reason` says which repair the user needs. */
  | { status: "expired"; reason: PushDisabledReason; statusCode?: number }
  /** Might work next time. The caller counts these. */
  | { status: "transient"; message: string; statusCode?: number };

/**
 * The only file in `src/` that imports `web-push`, enforced by
 * `push-secret.guard.spec.ts`.
 *
 * Business features never reach a transport. They ask the notification layer to
 * deliver something and this class decides what the wire looks like -- which is
 * what will let ntfy or UnifiedPush arrive later without budgets, bills or
 * backups changing (discussion #1291, "delivery isolation").
 *
 * **Never throws.** A push is an external side effect that PostgreSQL cannot
 * roll back and that must not roll anything back either: a failed delivery
 * returns an outcome, so the financial operation that produced the notification
 * is never undone by the notification about it.
 */
@Injectable()
export class WebPushSender {
  private readonly logger = new Logger(WebPushSender.name);

  constructor(private readonly pushConfig: PushConfigService) {}

  async send(
    target: PushTarget,
    payload: PushPayload,
  ): Promise<PushSendOutcome> {
    const identity = await this.pushConfig.getVapidIdentity();
    if (!identity) return { status: "unconfigured" };

    // A subscription minted under a superseded key pair cannot be delivered to:
    // the push service checks the VAPID signature against the key the
    // subscription was created with. Caught here as well as at rotation time so
    // an interrupted rotation cannot produce an endless stream of 403s.
    if (target.vapidPublicKey !== identity.publicKey) {
      return {
        status: "expired",
        reason: PushDisabledReason.KEY_ROTATED,
      };
    }

    try {
      await webpush.sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: identity.publicKey,
            privateKey: identity.privateKey,
          },
          TTL: PUSH_TTL_SECONDS,
        },
      );
      return { status: "sent" };
    } catch (error) {
      return this.classify(error);
    }
  }

  /**
   * Which of the three a failure is.
   *
   * Only 404 and 410 retire a device. They are the push service saying the
   * subscription itself is gone -- browser data cleared, PWA removed, permission
   * revoked, subscription rotated -- and re-attempting is guaranteed to fail.
   *
   * Everything else is transient, 401 and 403 included, and that is deliberate:
   * an authorization failure usually means *our* key or clock is wrong, not that
   * the device went away, and retiring on it would empty every device list in
   * the deployment over one bad configuration. `MAX_CONSECUTIVE_FAILURES`
   * retires a device that keeps failing for any reason, so nothing is retried
   * forever either way.
   */
  private classify(error: unknown): PushSendOutcome {
    const statusCode =
      typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : undefined;
    const message =
      error instanceof Error ? error.message : "unknown push failure";

    if (statusCode === 404 || statusCode === 410) {
      return {
        status: "expired",
        reason: PushDisabledReason.GONE,
        statusCode,
      };
    }

    this.logger.warn(
      `Web Push delivery failed${statusCode ? ` with ${statusCode}` : ""}: ${message}`,
    );
    return { status: "transient", message, statusCode };
  }
}
