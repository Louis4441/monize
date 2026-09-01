import { Injectable, Logger } from "@nestjs/common";
import * as webpush from "web-push";
import * as https from "node:https";
import type { Socket } from "node:net";
import { PushConfigService, VAPID_SUBJECT } from "./push-config.service";
import { PushDisabledReason } from "./entities/push-subscription.entity";
import {
  URL_SAFETY_CHECK_TIMEOUT_MS,
  validateUrlIsSafeWithin,
} from "../ai/validators/safe-url.validator";

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
 * How long one delivery may take before it is abandoned.
 *
 * Node's https client has no default timeout and `web-push` adds none, so an
 * endpoint host that accepts the connection and then stalls holds the socket --
 * and the request that triggered the send -- for as long as it likes. The
 * endpoint is a user-supplied host, which makes "as long as it likes" a choice
 * somebody else gets to make.
 */
export const PUSH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * The whole-delivery deadline, which is a different guarantee from the one
 * above.
 *
 * `PUSH_REQUEST_TIMEOUT_MS` becomes Node's socket timeout, and that is an
 * INACTIVITY timer: a host that sends one byte every four seconds resets it
 * forever, so it bounds a peer that goes silent and nothing else. This bounds
 * the delivery itself, and expiring it destroys the socket -- abandoning the
 * promise alone would leave `web-push` reading into `responseText += chunk`,
 * which has no cap, from a host the caller chose.
 *
 * Generous against the inactivity timeout on purpose: a real push service
 * answering slowly under load must not be mistaken for a stalling one, and the
 * cheaper timer already covers silence.
 */
export const PUSH_REQUEST_DEADLINE_MS = 15_000;

/** What a delivery that ran out of time reports, so `classify` can see it. */
export const PUSH_DEADLINE_MESSAGE = "push delivery deadline exceeded";

/**
 * How long the per-send endpoint re-check may take.
 *
 * The bound itself belongs to the check (`URL_SAFETY_CHECK_TIMEOUT_MS`): an
 * unbounded DNS lookup is a hazard wherever that check runs, and it ran
 * unbounded in `IsPushEndpoint` while this file raced it. Re-exported under the
 * push name because `sendTest`'s documented worst case is composed from it.
 */
export const PUSH_ENDPOINT_RECHECK_TIMEOUT_MS = URL_SAFETY_CHECK_TIMEOUT_MS;

/**
 * Make an agent's connections observable, so a deadline can close them.
 *
 * `createConnection` is the one place a connection becomes visible from outside
 * the agent, and Node types it as an overload set -- so the wrapper is written
 * against `unknown[]` and forwards whatever it was given, recording only the
 * result. Exported because it is the mechanism the deadline depends on, and a
 * mechanism nothing can test on its own is a mechanism nobody checks.
 */
export function collectAgentSockets(agent: https.Agent): Socket[] {
  const sockets: Socket[] = [];
  const hooked = agent as unknown as {
    createConnection: (...args: unknown[]) => Socket;
  };
  const connect = hooked.createConnection.bind(agent);
  hooked.createConnection = (...args: unknown[]): Socket => {
    const socket = connect(...args);
    sockets.push(socket);
    return socket;
  };
  return sockets;
}

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
  /**
   * What this notification is ABOUT, for the worker's collapse decision -- or
   * `null` to mean "collapse every notification of this type onto one".
   *
   * Required rather than optional, so a producer states which it means. The
   * browser replaces a shown notification whose `tag` matches, so the tag is a
   * subject identity: two bills due on the same day are both `BILL_DUE`, and
   * grouping by type alone showed the reader one of them and dropped the other.
   * A ROUTE is not a subject either -- the bill producer sends every reminder to
   * `/bills`, because no per-bill page exists -- which is why this is its own
   * field and not derived from `target`.
   *
   * `null` is the right answer where the type really does describe one subject:
   * a test send, or "email delivery is failing", where four stacked copies are
   * worse than one.
   *
   * Never a value the user would mind seeing: the payload is end-to-end
   * encrypted to the device, but a collapse key is metadata, so it carries an
   * id, not a name or an amount.
   */
  collapseKey: string | null;
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
 * The only file in `src/` that *sends*, enforced by `push-secret.guard.spec.ts`.
 * (`PushConfigService` also imports `web-push`, for key generation and nothing
 * else; the guard's allowlist names both files and their reasons.)
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

    // Re-checked on every send, not only at registration. `IsPushEndpoint` runs
    // once, when the row is written, and the row then names a host this server
    // POSTs to for as long as it lives -- so a name that resolved publicly then
    // and resolves to a private address now would turn each send into an
    // internal request. Reported as transient rather than as a distinct state:
    // the bounded retry retires it as FAILING, which is what actually happened.
    if (!(await this.endpointStillSafe(target.endpoint))) {
      this.logger.warn(
        "Refusing a push to an endpoint that could not be confirmed as a public host",
      );
      return {
        status: "transient",
        message: "endpoint could not be confirmed as a public host",
      };
    }

    try {
      await this.deliverWithDeadline(target, payload, identity);
      return { status: "sent" };
    } catch (error) {
      return this.classify(error);
    }
  }

  /**
   * One delivery, under a deadline this service owns.
   *
   * `web-push`'s `timeout` option becomes Node's socket timeout, which is an
   * INACTIVITY timer: an endpoint that trickles one byte every four seconds
   * never trips a five-second one, so the option is not an upper bound on
   * anything. And the endpoint is a host the CALLER registered -- `IsPushEndpoint`
   * proves it is https and public, not that it is a push service -- so a slow
   * peer is reachable on purpose: `POST /push/test` would hold its request open
   * for as long as that host cared to, while `web-push` grew `responseText +=
   * chunk` with no cap on it.
   *
   * So the deadline is a race, and losing it DESTROYS THE SOCKET rather than
   * merely abandoning the promise -- an orphaned request keeps reading, which is
   * the half that costs memory. The socket is reachable because the agent is
   * ours: `web-push` forwards `options.agent` to `https.request`, and
   * `createConnection` is where a connection becomes visible.
   *
   * The inactivity timeout stays as well. It is the cheaper answer for a host
   * that stops answering entirely, and it costs nothing to keep.
   */
  private async deliverWithDeadline(
    target: PushTarget,
    payload: PushPayload,
    identity: { publicKey: string; privateKey: string },
  ): Promise<void> {
    const agent = new https.Agent({ keepAlive: false });
    const sockets = collectAgentSockets(agent);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        webpush.sendNotification(
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
            timeout: PUSH_REQUEST_TIMEOUT_MS,
            agent,
          },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            reject(new Error(PUSH_DEADLINE_MESSAGE));
          }, PUSH_REQUEST_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      agent.destroy();
    }
  }

  /**
   * The endpoint check, bounded. A timeout answers `false`: not knowing whether
   * a host is public is not the same as knowing it is, and only one of those
   * two is a reason to POST to it.
   */
  private async endpointStillSafe(endpoint: string): Promise<boolean> {
    try {
      return await validateUrlIsSafeWithin(
        endpoint,
        PUSH_ENDPOINT_RECHECK_TIMEOUT_MS,
      );
    } catch {
      // `validateUrlIsSafeWithin` catches its own, so this is not a second
      // guess at the same failure: this class promises never to throw, and that
      // promise cannot rest on a collaborator's internals. It is also the one
      // call outside `send`'s own try, which is deliberate -- a refused
      // endpoint is not a failed delivery.
      return false;
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
