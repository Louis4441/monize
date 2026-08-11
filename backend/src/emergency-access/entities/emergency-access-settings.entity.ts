import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

@Entity("emergency_access_settings")
export class EmergencyAccessSettings {
  @PrimaryColumn("uuid", { name: "owner_user_id" })
  ownerUserId: string;

  @Column({ type: "boolean", default: false })
  enabled: boolean;

  @Column({ name: "grant_after_days", type: "int", default: 14 })
  grantAfterDays: number;

  @Column({ name: "reminder_after_days", type: "int", default: 7 })
  reminderAfterDays: number;

  @Column({ name: "message_ciphertext", type: "text", nullable: true })
  messageCiphertext: string | null;

  @Column({ name: "last_reminder_sent_at", type: "timestamp", nullable: true })
  lastReminderSentAt: Date | null;

  @Column({ name: "granted_at", type: "timestamp", nullable: true })
  grantedAt: Date | null;

  /**
   * Which grant cycle this owner is on.
   *
   * Advanced by the one statement that transitions ungranted -> granted
   * (`claimGrant`), so per-contact delivery state belongs to a cycle rather than
   * to the contact row. That placement is the point: the alternative -- clearing
   * each contact's delivery marker in every path that re-arms monitoring -- has
   * five call sites across three files today, and a missed one disarms the
   * safeguard silently. Nothing has to remember anything here; a contact whose
   * `notifiedGrantGeneration` is not this number is owed a link (audit RRV4-004).
   *
   * `update: false` because it is a database-owned counter: the only write that may
   * touch it is `claimGrant`'s `grant_generation = grant_generation + 1`. Any
   * `repo.save` of a settings entity carries whatever value was loaded, and TypeORM
   * writes back every column differing from the row it reloads at persist time -- so
   * a concurrent bump landing between an unrelated read and its save would be
   * written *back down*, and a settings generation below a contact's turns the
   * pending query into a daily re-issue loop against that contact. Excluding it from
   * updates is the version of that rule the ORM can enforce.
   */
  @Column({ name: "grant_generation", type: "int", default: 1, update: false })
  grantGeneration: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @OneToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "owner_user_id" })
  owner: User;
}
