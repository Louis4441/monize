import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, IsNull } from "typeorm";
import * as crypto from "crypto";
import { I18nService } from "nestjs-i18n";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { affectedRowCount, returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { UserPreference } from "../users/entities/user-preference.entity";
import { PushConfigService } from "./push-config.service";
import {
  PushDisabledReason,
  PushSubscription,
} from "./entities/push-subscription.entity";
import {
  MAX_CONSECUTIVE_FAILURES,
  PushSendOutcome,
  WebPushSender,
} from "./web-push-sender.service";
import { CreatePushSubscriptionDto } from "./dto/create-push-subscription.dto";

/** How many hex characters of the endpoint digest identify a device publicly. */
export const ENDPOINT_FINGERPRINT_LENGTH = 16;

/** One of the caller's own devices, as the settings page renders it. */
export interface PushDeviceDto {
  id: string;
  /**
   * A prefix of the endpoint's SHA-256, so the browser can recognise which row
   * is the device it is looking at.
   *
   * The endpoint itself is a delivery credential and never leaves the server:
   * anyone holding it plus the two keys can push to that device. A digest
   * prefix answers "is this me?" and nothing else.
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

/** Per-device result of a test send, so the UI can name the device that failed. */
export interface PushTestDeviceResult {
  id: string;
  deviceName: string | null;
  status: PushSendOutcome["status"];
  /** Set only for a device this send retired, so the UI can explain the repair. */
  disabledReason?: PushDisabledReason;
}

export interface PushTestResult {
  attempted: number;
  delivered: number;
  devices: PushTestDeviceResult[];
}

export function hashEndpoint(endpoint: string): string {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

/** Longest `User-Agent` stored; matches `push_subscriptions.user_agent`. */
export const MAX_USER_AGENT_LENGTH = 255;

/**
 * A user's own push devices: registering one, listing them, removing one, and
 * sending that user a test notification.
 *
 * Every method takes `userId` from the JWT at the controller and never from a
 * payload, and every ownership check runs inside the same transaction as the
 * write it guards -- a 404 cannot un-commit a row.
 */
@Injectable()
export class PushSubscriptionService {
  private readonly logger = new Logger(PushSubscriptionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushConfig: PushConfigService,
    private readonly sender: WebPushSender,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Register (or refresh) the calling user's device.
   *
   * Two transactions, deliberately, and the first one is the security half.
   * `pushManager.subscribe()` is scoped to a browser profile and an origin, so
   * two accounts used in one browser are handed the *same* endpoint and the
   * same encryption keys. The endpoint is therefore globally unique and a
   * second account's subscribe is a takeover: any row another user holds for
   * this endpoint is removed first, under system context, because "who else
   * claims this device" is a cross-user question no tenant transaction can see.
   * Without it, a notification addressed to the first account would be
   * decrypted and displayed on the device the second account is now using.
   *
   * The two statements are not atomic with each other, and the failure mode of
   * losing that race is the *safe* one: whoever commits second gets a unique
   * violation surfaced as a 409, never a second row for one endpoint.
   */
  async subscribe(
    userId: string,
    dto: CreatePushSubscriptionDto,
    userAgent: string | null,
  ): Promise<PushDeviceDto> {
    const config = await this.pushConfig.getPublicConfig();
    if (!config.enabled || !config.publicKey) {
      throw new BadRequestException(
        tr(
          "errors.push.channelUnavailable",
          "Push notifications are not available on this Monize instance.",
        ),
      );
    }

    const endpointHash = hashEndpoint(dto.endpoint);
    await this.releaseEndpointFromOtherUsers(endpointHash, userId);

    const row = await withScopedDb(this.dataSource, async (manager) => {
      const inserted = await manager.query(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, endpoint_hash, p256dh, auth, device_name,
            user_agent, vapid_public_key, created_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (endpoint_hash) DO UPDATE
            SET p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth,
                device_name = COALESCE(EXCLUDED.device_name, push_subscriptions.device_name),
                user_agent = EXCLUDED.user_agent,
                vapid_public_key = EXCLUDED.vapid_public_key,
                last_seen_at = CURRENT_TIMESTAMP,
                failure_count = 0,
                disabled_at = NULL,
                disabled_reason = NULL
          WHERE push_subscriptions.user_id = EXCLUDED.user_id
       RETURNING id`,
        [
          userId,
          dto.endpoint,
          endpointHash,
          dto.p256dh,
          dto.auth,
          dto.deviceName ?? null,
          userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
          config.publicKey,
        ],
      );

      const ids = returnedRows<{ id: string }>(inserted);
      if (ids.length === 0) {
        // The conflicting row belongs to somebody else: the takeover above lost
        // its race. Refusing is the only honest answer -- writing anyway would
        // put two accounts on one device.
        throw new ConflictException(
          tr(
            "errors.push.endpointClaimed",
            "This browser is already registered to a different Monize account. Sign out of that account in this browser and try again.",
          ),
        );
      }

      // The response is read back from the committed row rather than assembled
      // from the values we sent: on the DO UPDATE arm the stored device name may
      // be the one already there (COALESCE above), which the request never saw.
      const saved = await manager
        .getRepository(PushSubscription)
        .findOne({ where: { id: ids[0].id } });
      if (!saved) {
        throw new ConflictException(
          tr(
            "errors.push.endpointClaimed",
            "This browser is already registered to a different Monize account. Sign out of that account in this browser and try again.",
          ),
        );
      }
      return saved;
    });

    return toDeviceDto(row);
  }

  /**
   * Drop any *other* user's claim on this endpoint.
   *
   * System context because the rows being removed belong to a different tenant
   * by definition -- a user transaction cannot see them, and under RLS
   * enforcement the conflicting row would be invisible to the upsert's DO UPDATE
   * arm and surface as an unresolvable unique violation instead.
   */
  private async releaseEndpointFromOtherUsers(
    endpointHash: string,
    userId: string,
  ): Promise<void> {
    const removed = await withSystemContext(() =>
      withScopedDb(this.dataSource, async (manager) => {
        const result = await manager.query(
          `DELETE FROM push_subscriptions
            WHERE endpoint_hash = $1 AND user_id <> $2`,
          [endpointHash, userId],
        );
        return affectedRowCount(result);
      }),
    );
    if (removed > 0) {
      this.logger.log(
        `Re-assigned ${removed} push subscription(s) for a shared browser endpoint to the account that just subscribed`,
      );
    }
  }

  async listForUser(userId: string): Promise<PushDeviceDto[]> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(PushSubscription).find({
        where: { userId },
        order: { lastSeenAt: "DESC" },
      }),
    );
    return rows.map(toDeviceDto);
  }

  async remove(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const result = await manager.query(
        "DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2",
        [id, userId],
      );
      if (affectedRowCount(result) === 0) {
        throw new NotFoundException(
          tr("errors.push.deviceNotFound", "Push device not found."),
        );
      }
    });
  }

  /**
   * Send the calling user a test notification on every one of their live
   * devices, and record what each attempt did.
   *
   * The sends happen outside any transaction and the bookkeeping follows them:
   * a push is an external side effect PostgreSQL cannot roll back, so the order
   * that survives is "do the thing, then write down what happened"
   * (`docs/external-side-effects.md`).
   */
  async sendTest(userId: string): Promise<PushTestResult> {
    const config = await this.pushConfig.getPublicConfig();
    if (!config.enabled) {
      throw new BadRequestException(
        tr(
          "errors.push.channelUnavailable",
          "Push notifications are not available on this Monize instance.",
        ),
      );
    }

    const targets = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(PushSubscription).find({
        where: { userId, disabledAt: IsNull() },
        order: { lastSeenAt: "DESC" },
      }),
    );
    if (targets.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.push.noDevices",
          "No push devices are registered for this account. Enable push notifications in this browser first.",
        ),
      );
    }

    // Composed on the server, so the recipient's stored language is the only
    // locale available -- exactly the reason emails resolve theirs this way.
    const lang = await withScopedDb(this.dataSource, (manager) =>
      resolveUserEmailLocale(manager.getRepository(UserPreference), userId),
    );
    const t = emailTranslator(this.i18n, lang);
    const payload = {
      type: "TEST",
      title: t("push.test.title", "Monize test notification"),
      body: t(
        "push.test.body",
        "Push notifications are working on this device.",
      ),
      target: "/settings",
    };

    const devices: PushTestDeviceResult[] = [];
    let delivered = 0;
    for (const target of targets) {
      const outcome = await this.sender.send(
        {
          endpoint: target.endpoint,
          p256dh: target.p256dh,
          auth: target.auth,
          vapidPublicKey: target.vapidPublicKey,
        },
        payload,
      );
      const disabledReason = await this.recordOutcome(
        userId,
        target.id,
        outcome,
      );
      if (outcome.status === "sent") delivered += 1;
      devices.push({
        id: target.id,
        deviceName: target.deviceName,
        status: outcome.status,
        ...(disabledReason ? { disabledReason } : {}),
      });
    }

    return { attempted: targets.length, delivered, devices };
  }

  /**
   * Write down what one delivery attempt did, and return the reason the device
   * was retired if this attempt retired it.
   *
   * Ownership is in the `WHERE` of every statement rather than checked first:
   * the caller already loaded the row under its own tenant transaction, and
   * re-deriving it here keeps the write unable to touch another account's device
   * even if a future caller passes the wrong id.
   */
  private async recordOutcome(
    userId: string,
    subscriptionId: string,
    outcome: PushSendOutcome,
  ): Promise<PushDisabledReason | undefined> {
    if (outcome.status === "unconfigured") return undefined;

    if (outcome.status === "sent") {
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE push_subscriptions
              SET last_success_at = CURRENT_TIMESTAMP,
                  last_seen_at = CURRENT_TIMESTAMP,
                  failure_count = 0
            WHERE id = $1 AND user_id = $2`,
          [subscriptionId, userId],
        ),
      );
      return undefined;
    }

    if (outcome.status === "expired") {
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE push_subscriptions
              SET disabled_at = CURRENT_TIMESTAMP,
                  disabled_reason = $3,
                  failure_count = failure_count + 1
            WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL`,
          [subscriptionId, userId, outcome.reason],
        ),
      );
      return outcome.reason;
    }

    // Transient: count it, and retire the device once the bound is reached so a
    // dead endpoint is not attempted forever.
    const retired = await withScopedDb(this.dataSource, async (manager) => {
      const result = await manager.query(
        `UPDATE push_subscriptions
            SET failure_count = failure_count + 1,
                disabled_at = CASE
                  WHEN failure_count + 1 >= $3 THEN CURRENT_TIMESTAMP
                  ELSE disabled_at END,
                disabled_reason = CASE
                  WHEN failure_count + 1 >= $3 THEN $4
                  ELSE disabled_reason END
          WHERE id = $1 AND user_id = $2
      RETURNING disabled_reason`,
        [
          subscriptionId,
          userId,
          MAX_CONSECUTIVE_FAILURES,
          PushDisabledReason.FAILING,
        ],
      );
      const rows = returnedRows<{ disabled_reason: string | null }>(result);
      return rows[0]?.disabled_reason === PushDisabledReason.FAILING;
    });
    return retired ? PushDisabledReason.FAILING : undefined;
  }
}

function toDeviceDto(row: PushSubscription): PushDeviceDto {
  return {
    id: row.id,
    endpointFingerprint: row.endpointHash.slice(0, ENDPOINT_FINGERPRINT_LENGTH),
    deviceName: row.deviceName,
    userAgent: row.userAgent,
    createdAt: new Date(row.createdAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    lastSuccessAt: row.lastSuccessAt
      ? new Date(row.lastSuccessAt).toISOString()
      : null,
    disabledAt: row.disabledAt ? new Date(row.disabledAt).toISOString() : null,
    disabledReason: row.disabledReason,
  };
}
