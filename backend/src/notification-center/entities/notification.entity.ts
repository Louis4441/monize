import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Budget } from "../../budgets/entities/budget.entity";
import { BudgetCategory } from "../../budgets/entities/budget-category.entity";
import { User } from "../../users/entities/user.entity";

/**
 * What produced a notification. Values must fit the `alert_type` VARCHAR(30)
 * column -- a guard test in `notification-category.spec.ts` holds the bound.
 */
export enum NotificationType {
  PACE_WARNING = "PACE_WARNING",
  THRESHOLD_WARNING = "THRESHOLD_WARNING",
  THRESHOLD_CRITICAL = "THRESHOLD_CRITICAL",
  OVER_BUDGET = "OVER_BUDGET",
  FLEX_GROUP_WARNING = "FLEX_GROUP_WARNING",
  SEASONAL_SPIKE = "SEASONAL_SPIKE",
  PROJECTED_OVERSPEND = "PROJECTED_OVERSPEND",
  INCOME_SHORTFALL = "INCOME_SHORTFALL",
  POSITIVE_MILESTONE = "POSITIVE_MILESTONE",
  BILL_DUE = "BILL_DUE",
  // System-level notifications (budget_id NULL, carrying a dedupe_key).
  // Admin-facing types are fanned out one row per administrator by
  // SystemAlertService; SCHEDULED_POST_FAILED goes to the affected user.
  BACKUP_FAILED = "BACKUP_FAILED",
  BACKUP_PARTIAL = "BACKUP_PARTIAL",
  ENCRYPTION_KEY_MISSING = "ENCRYPTION_KEY_MISSING",
  PROVIDER_OUTAGE = "PROVIDER_OUTAGE",
  PROVIDER_RECOVERED = "PROVIDER_RECOVERED",
  SMTP_FAILURE = "SMTP_FAILURE",
  SCHEDULED_POST_FAILED = "SCHEDULED_POST_FAILED",
}

/**
 * The system half of the type partition above, written once so every consumer
 * of "system vs financial" (the dismiss-matching filter, the frontend's
 * mirrored copy in the frontend's notification types) derives from one set.
 * Financial is NOT IN this set -- never a second list.
 */
export const SYSTEM_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.BACKUP_FAILED,
  NotificationType.BACKUP_PARTIAL,
  NotificationType.ENCRYPTION_KEY_MISSING,
  NotificationType.PROVIDER_OUTAGE,
  NotificationType.PROVIDER_RECOVERED,
  NotificationType.SMTP_FAILURE,
  NotificationType.SCHEDULED_POST_FAILED,
];

/**
 * How urgent, and how it is drawn. This is the `priority` axis discussion #1291
 * asked for: it has carried exactly that meaning since the first budget alert,
 * so there is no second column beside it. Two columns on one axis is how the
 * answers drift.
 */
export enum NotificationSeverity {
  INFO = "info",
  WARNING = "warning",
  CRITICAL = "critical",
  SUCCESS = "success",
}

/**
 * What a notification is *about*, as opposed to what produced it.
 *
 * The axis a per-category preference keys on ("tell me about budgets, not about
 * price refreshes"), which is why it exists separately from the type: there are
 * ten budget types and one preference. Kept deliberately small -- a category
 * nobody can express a preference about is a value, not a category. The
 * discussion's fuller list (Investments, Goals, Imports) arrives with the
 * producers that need it, not before.
 */
export enum NotificationCategory {
  PAYMENTS = "PAYMENTS",
  BUDGETS = "BUDGETS",
  SYSTEM = "SYSTEM",
}

/**
 * The category a type belongs to, derived rather than chosen -- and derived
 * rather than stored.
 *
 * There is no `category` column. A stored copy would be a second answer to a
 * question the row already answers through `alert_type`, kept true only by every
 * producer remembering to write it: the one raw INSERT in this codebase would
 * have taken the column default and filed budget alerts under SYSTEM. As one
 * total function over the enum, a row cannot disagree with itself, and
 * re-classifying a type applies to the history a preference filters as well as
 * to the next row.
 */
export function notificationCategoryOf(
  type: NotificationType,
): NotificationCategory {
  if (type === NotificationType.BILL_DUE) return NotificationCategory.PAYMENTS;
  if (SYSTEM_NOTIFICATION_TYPES.includes(type)) {
    return NotificationCategory.SYSTEM;
  }
  return NotificationCategory.BUDGETS;
}

/**
 * The alert types belonging to a category, derived from `notificationCategoryOf`
 * rather than listed -- so the reverse mapping cannot disagree with the forward
 * one (there is no category column; the throttle window has to filter the
 * `notifications` table by the types the category expands to). Every type lands
 * in exactly one category's set. `notification-category.spec.ts` proves the
 * round trip.
 */
export function typesForCategory(
  category: NotificationCategory,
): NotificationType[] {
  return Object.values(NotificationType).filter(
    (type) => notificationCategoryOf(type) === category,
  );
}

/**
 * Total order on severity, for the throttle's escalation exception: a new
 * notification of a category is suppressed within the window UNLESS it is
 * strictly more severe than every non-dismissed one already there, because
 * silence on an escalation (a `critical` after a `warning`) is the dangerous
 * direction. `success` is a positive milestone, ranked below the warnings it is
 * never an escalation of.
 */
const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  [NotificationSeverity.INFO]: 0,
  [NotificationSeverity.SUCCESS]: 1,
  [NotificationSeverity.WARNING]: 2,
  [NotificationSeverity.CRITICAL]: 3,
};

export function severityRank(severity: NotificationSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

const dateTransformer = {
  from: (value: string | Date): string => {
    if (!value) return value as string;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date) => value,
};

/**
 * One durable notification, whatever produced it.
 *
 * Renamed from `budget_alerts` by migration 172: the table stopped being about
 * budgets when the first BACKUP_FAILED row landed in it, and a name that lies is
 * how a second table gets created beside it. `NotificationService` is the only
 * door that writes one.
 */
@Entity("notifications")
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "budget_id", nullable: true })
  budgetId: string | null;

  @ManyToOne(() => Budget, { nullable: true })
  @JoinColumn({ name: "budget_id" })
  budget: Budget | null;

  @Column({ type: "uuid", name: "budget_category_id", nullable: true })
  budgetCategoryId: string | null;

  @ManyToOne(() => BudgetCategory, { nullable: true })
  @JoinColumn({ name: "budget_category_id" })
  budgetCategory: BudgetCategory | null;

  /**
   * Still `alert_type` in the database: renaming a column is a rewrite of every
   * index that names it and every query that reads it, for a synonym. The
   * property is what code says.
   */
  @Column({ type: "varchar", length: 30, name: "alert_type" })
  type: NotificationType;

  @Column({ type: "varchar", length: 20 })
  severity: NotificationSeverity;

  @Column({ type: "varchar", length: 255 })
  title: string;

  @Column({ type: "text" })
  message: string;

  @Column({ type: "jsonb", default: {} })
  data: Record<string, unknown>;

  /**
   * The in-app path this points at. Always a same-origin path, never a URL --
   * the service worker resolves it against the app's own origin and discards
   * anything that leaves it, and the bell links to it the same way.
   */
  @Column({ type: "varchar", length: 255, nullable: true })
  target: string | null;

  @Column({ name: "is_read", default: false })
  isRead: boolean;

  @Column({ name: "is_email_sent", default: false })
  isEmailSent: boolean;

  @Column({
    type: "date",
    name: "period_start",
    transformer: dateTransformer,
  })
  periodStart: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @Column({ type: "timestamp", name: "dismissed_at", nullable: true })
  dismissedAt: Date | null;

  /**
   * Explicit fingerprint for system notifications (budget_id NULL), where the
   * fingerprint unique index cannot arbitrate (NULL never equals NULL). Unique
   * per (user_id, dedupe_key) via the partial index
   * `idx_notifications_dedupe`; budget-generated rows leave it NULL.
   */
  @Column({ type: "varchar", length: 120, name: "dedupe_key", nullable: true })
  dedupeKey: string | null;
}
