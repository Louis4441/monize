import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

import { NotificationCategory } from "./notification.entity";

/**
 * One row per (user, category): which delivery channels that user wants for a
 * family of notifications. See `docs/specs/notification-preferences.md`.
 *
 * `category` is a derived {@link NotificationCategory}, never a raw
 * `alert_type` -- so a new notification type needs no new preference row.
 *
 * Phase 1 carries the one channel live in production today, `email`. Push,
 * UnifiedPush and the throttle window arrive with the dispatch that reads them,
 * as their own columns, so the table never holds a channel nothing consults.
 * An ABSENT row means the default matrix (email defaults on, narrowed by the
 * global `user_preferences.notification_email` master switch) -- the resolver,
 * not this row, decides a default.
 */
@Entity("notification_preferences")
export class NotificationPreference {
  @PrimaryColumn({ type: "uuid", name: "user_id" })
  userId: string;

  @PrimaryColumn({ type: "varchar", length: 20 })
  category: NotificationCategory;

  @Column({ type: "boolean", default: true })
  email: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
