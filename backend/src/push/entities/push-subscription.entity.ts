import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";

/**
 * Why a subscription stops being usable. Stored so the device list can say
 * which of the three happened instead of rendering a bare "unavailable" -- the
 * repairs differ (re-enable push in the browser, subscribe again after a key
 * rotation, nothing at all for a device that has simply gone).
 */
export enum PushDisabledReason {
  /** The push service answered 404/410: this subscription no longer exists. */
  GONE = "GONE",
  /** Minted under a superseded VAPID key pair; the signature would be rejected. */
  KEY_ROTATED = "KEY_ROTATED",
  /** Bounded retry exhausted -- `MAX_CONSECUTIVE_FAILURES` transient failures. */
  FAILING = "FAILING",
}

/**
 * One browser profile's Web Push registration: the endpoint at the push service
 * plus the two keys that encrypt to it.
 *
 * User-owned and policied like any other user table. The endpoint, though, is
 * unique **globally** rather than per user, and that is a security property
 * rather than a normalization choice: `pushManager.subscribe()` is scoped to a
 * browser profile and an origin, not to a Monize session, so two people sharing
 * one browser receive the same endpoint and the same encryption keys. Per-user
 * uniqueness would leave both rows alive and let a notification addressed to
 * the first account be decrypted and displayed on the device the second account
 * is now using. One row per endpoint makes the second subscribe a takeover.
 */
@Entity("push_subscriptions")
export class PushSubscription {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @Column({ type: "text" })
  endpoint: string;

  /** SHA-256 hex of `endpoint`; the indexed form, since the endpoint is unbounded. */
  @Column({ name: "endpoint_hash", type: "varchar", length: 64 })
  endpointHash: string;

  @Column({ type: "varchar", length: 255 })
  p256dh: string;

  @Column({ type: "varchar", length: 255 })
  auth: string;

  @Column({ name: "device_name", type: "varchar", length: 100, nullable: true })
  deviceName: string | null;

  @Column({ name: "user_agent", type: "varchar", length: 255, nullable: true })
  userAgent: string | null;

  /**
   * The instance identity this subscription was minted under. A rotation makes
   * every older subscription undeliverable, so this column is what lets the
   * sender skip a stale row even if the rotation that should have disabled it
   * was interrupted.
   */
  @Column({ name: "vapid_public_key", type: "varchar", length: 200 })
  vapidPublicKey: string;

  @Column({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @Column({ name: "last_seen_at", type: "timestamp" })
  lastSeenAt: Date;

  @Column({ name: "last_success_at", type: "timestamp", nullable: true })
  lastSuccessAt: Date | null;

  /** Consecutive transient failures. Reset by a success, not by time. */
  @Column({ name: "failure_count", type: "integer", default: 0 })
  failureCount: number;

  @Column({ name: "disabled_at", type: "timestamp", nullable: true })
  disabledAt: Date | null;

  @Column({
    name: "disabled_reason",
    type: "varchar",
    length: 40,
    nullable: true,
  })
  disabledReason: PushDisabledReason | null;
}
