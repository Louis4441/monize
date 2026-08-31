import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { DataSource, EntityManager, IsNull, Not } from "typeorm";
import * as crypto from "crypto";
import * as webpush from "web-push";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { EncryptionService } from "../common/encryption/encryption.service";
import { ENCRYPTION_KEY_ENV } from "../common/encryption/encryption-key";
import { PushInstanceConfig } from "./entities/push-instance-config.entity";
import {
  PushDisabledReason,
  PushSubscription,
} from "./entities/push-subscription.entity";

/**
 * The `sub` claim every VAPID signature carries: a stable address the push
 * service can use to reach whoever is sending. A constant rather than an
 * environment variable on purpose -- the whole point of generating keys on
 * first start is that a self-hosted administrator configures nothing, and a
 * second source of truth for one value is how the currency default drifted
 * across twenty-three call sites.
 */
export const VAPID_SUBJECT = "https://github.com/kenlasko/monize";

/** What the browser is told, and the only shape `/push/config` ever returns. */
export interface PublicPushConfig {
  /** Both halves true: the instance holds a key pair AND the channel is on. */
  enabled: boolean;
  /** Handed to `pushManager.subscribe()`. Public by construction. */
  publicKey: string | null;
  /** False when `ENCRYPTION_KEY` is absent, so the UI can say which it is. */
  configured: boolean;
}

/** The administrator's view. Adds provenance, never the private key. */
export interface AdminPushConfig extends PublicPushConfig {
  publicKeyFingerprint: string | null;
  generatedAt: string | null;
  /** Live devices across the whole deployment -- a count, never a device list. */
  liveSubscriptionCount: number;
  disabledSubscriptionCount: number;
}

/** What `WebPushSender` needs and nothing else may ask for. */
export interface VapidIdentity {
  publicKey: string;
  privateKey: string;
}

/**
 * A short, comparable name for a public key, so an administrator can tell two
 * instances apart without reading 87 base64 characters.
 */
export function fingerprintPublicKey(publicKey: string): string {
  return crypto
    .createHash("sha256")
    .update(publicKey)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Owns this deployment's Web Push identity: generating it once, handing the
 * public half out, decrypting the private half for the sender, and rotating the
 * pair.
 *
 * Every method seeds its own identity context. There is no request behind the
 * bootstrap hook, and rotation and the deployment counts are genuinely
 * cross-user questions -- one key pair serves every account -- so the reads and
 * writes here run under `withSystemContext` rather than the caller's.
 */
@Injectable()
export class PushConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PushConfigService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureKeyPair();
    } catch (error) {
      // Push is a side channel. An instance that cannot mint a key pair still
      // serves every financial route, so this is logged rather than thrown --
      // `configured: false` is what the UI acts on.
      this.logger.error(
        `Could not establish a Web Push key pair: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Read the deployment's key pair, generating it on first start.
   *
   * Returns `null` when `ENCRYPTION_KEY` is absent. Storing the private half in
   * plaintext would be worse than having no push at all, and the operator is
   * already told about the missing key by the weekly `ENCRYPTION_KEY_MISSING`
   * alert (`SystemAlertMonitorService`) -- raising a second alert for one cause
   * would send them to fix two things.
   */
  async ensureKeyPair(): Promise<PushInstanceConfig | null> {
    const existing = await this.readConfig();
    if (existing) return existing;

    if (!this.encryption.isConfigured()) {
      this.logger.warn(
        `Web Push is unavailable: ${ENCRYPTION_KEY_ENV} is not set, so the ` +
          "VAPID private key cannot be stored encrypted. Set it and restart to " +
          "enable push notifications.",
      );
      return null;
    }

    const generated = webpush.generateVAPIDKeys();
    return withSystemContext(() =>
      withScopedDb(this.dataSource, async (manager) => {
        // Every replica runs this hook, so the insert is the arbiter rather
        // than a read-then-write. A conflict means another replica won, and the
        // authoritative row is then re-read inside this same transaction --
        // never assembled from the values we tried to insert.
        await manager.query(
          `INSERT INTO push_instance_config
             (id, vapid_public_key, vapid_private_key_enc, vapid_generated_at)
           VALUES (TRUE, $1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO NOTHING`,
          [generated.publicKey, this.encryption.encrypt(generated.privateKey)],
        );
        const row = await manager
          .getRepository(PushInstanceConfig)
          .findOne({ where: { id: true } });
        if (row && row.vapidPublicKey === generated.publicKey) {
          this.logger.log(
            `Generated this instance's Web Push key pair (fingerprint ${fingerprintPublicKey(row.vapidPublicKey)})`,
          );
        }
        return row;
      }),
    );
  }

  /** The row as stored, or `null` when this instance has no push identity yet. */
  async readConfig(): Promise<PushInstanceConfig | null> {
    return withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager
          .getRepository(PushInstanceConfig)
          .findOne({ where: { id: true } }),
      ),
    );
  }

  async getPublicConfig(): Promise<PublicPushConfig> {
    const config = await this.readConfig();
    return {
      enabled: !!config && config.webPushEnabled,
      publicKey: config?.vapidPublicKey ?? null,
      configured: !!config,
    };
  }

  async getAdminConfig(): Promise<AdminPushConfig> {
    const config = await this.readConfig();
    const counts = await withSystemContext(() =>
      withScopedDb(this.dataSource, async (manager) => {
        const repo = manager.getRepository(PushSubscription);
        const [live, disabled] = await Promise.all([
          repo.count({ where: { disabledAt: IsNull() } }),
          repo.count({ where: { disabledAt: Not(IsNull()) } }),
        ]);
        return { live, disabled };
      }),
    );

    return {
      enabled: !!config && config.webPushEnabled,
      publicKey: config?.vapidPublicKey ?? null,
      configured: !!config,
      publicKeyFingerprint: config
        ? fingerprintPublicKey(config.vapidPublicKey)
        : null,
      generatedAt: config?.vapidGeneratedAt
        ? new Date(config.vapidGeneratedAt).toISOString()
        : null,
      liveSubscriptionCount: counts.live,
      disabledSubscriptionCount: counts.disabled,
    };
  }

  /**
   * The private half, decrypted. Called only by `WebPushSender`; a guard test
   * (`push-secret.guard.spec.ts`) fails when any other file reaches for it.
   */
  async getVapidIdentity(): Promise<VapidIdentity | null> {
    const config = await this.readConfig();
    if (!config || !config.webPushEnabled) return null;
    if (!this.encryption.canDecrypt(config.vapidPrivateKeyEnc)) {
      // A stored pair this instance cannot open is its own diagnosis: it
      // happens when ENCRYPTION_KEY changes under a live database. Saying so
      // beats an AES-GCM authentication failure surfacing as a generic 500.
      this.logger.error(
        `The stored VAPID private key cannot be decrypted with this instance's ${ENCRYPTION_KEY_ENV}. Rotate the key pair on the admin notifications page to recover; every device will re-subscribe.`,
      );
      return null;
    }
    return {
      publicKey: config.vapidPublicKey,
      privateKey: this.encryption.decrypt(config.vapidPrivateKeyEnc),
    };
  }

  async setWebPushEnabled(enabled: boolean): Promise<AdminPushConfig> {
    await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE push_instance_config
              SET web_push_enabled = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = TRUE`,
          [enabled],
        ),
      ),
    );
    return this.getAdminConfig();
  }

  /**
   * Mint a new key pair and disable every subscription in one transaction.
   *
   * The two halves are one decision, not two: a subscription created under the
   * old key can never be delivered to again -- the push service validates the
   * signature against the key the subscription was minted with -- so leaving
   * those rows enabled would be an interface that lists devices it cannot
   * reach. Either both land or neither does.
   */
  async rotateKeyPair(): Promise<{
    config: AdminPushConfig;
    disabled: number;
  }> {
    if (!this.encryption.isConfigured()) {
      return { config: await this.getAdminConfig(), disabled: 0 };
    }
    const generated = webpush.generateVAPIDKeys();
    const disabled = await withSystemContext(() =>
      withScopedDb(this.dataSource, async (manager) => {
        await manager.query(
          `INSERT INTO push_instance_config
             (id, vapid_public_key, vapid_private_key_enc, vapid_generated_at, updated_at)
           VALUES (TRUE, $1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE
              SET vapid_public_key = EXCLUDED.vapid_public_key,
                  vapid_private_key_enc = EXCLUDED.vapid_private_key_enc,
                  vapid_generated_at = EXCLUDED.vapid_generated_at,
                  updated_at = EXCLUDED.updated_at`,
          [generated.publicKey, this.encryption.encrypt(generated.privateKey)],
        );
        return this.disableStaleSubscriptions(manager, generated.publicKey);
      }),
    );
    this.logger.log(
      `Rotated the Web Push key pair (fingerprint ${fingerprintPublicKey(generated.publicKey)}); ${disabled} subscription(s) must re-register`,
    );
    return { config: await this.getAdminConfig(), disabled };
  }

  /**
   * Disable every live subscription not minted under `currentPublicKey`.
   *
   * Takes an `EntityManager` rather than opening its own transaction so the
   * rotation's two writes commit together.
   */
  private async disableStaleSubscriptions(
    manager: EntityManager,
    currentPublicKey: string,
  ): Promise<number> {
    const result = await manager.query(
      `UPDATE push_subscriptions
          SET disabled_at = CURRENT_TIMESTAMP, disabled_reason = $1
        WHERE disabled_at IS NULL
          AND vapid_public_key <> $2`,
      [PushDisabledReason.KEY_ROTATED, currentPublicKey],
    );
    // UPDATE returns the [rows, rowCount] tuple; see common/db/query-result.ts.
    return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
  }
}
