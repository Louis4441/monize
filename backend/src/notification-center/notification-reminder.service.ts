import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, EntityManager, IsNull } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import {
  Notification,
  NotificationSeverity,
  NotificationType,
} from "./entities/notification.entity";
import {
  NotificationReminder,
  ReminderRepeatMode,
} from "./entities/notification-reminder.entity";
import {
  NotificationService,
  DEDUPE_KEY_MAX_LENGTH,
} from "./notification.service";
import { CreateNotificationReminderDto } from "./dto/create-notification-reminder.dto";
import {
  MAX_ACTIVE_REMINDERS_PER_USER,
  REMINDER_MAX_INTERVAL_MINUTES,
  REMINDER_MIN_INTERVAL_MINUTES,
} from "./notification-reminder.constants";

/** Longest `dedupe_base`, matching `notification_reminders.dedupe_base`. */
export const DEDUPE_BASE_MAX_LENGTH = 80;

/** The reminder a caller sees. The template's `data` is not returned wholesale. */
export interface NotificationReminderView {
  id: string;
  sourceNotificationId: string | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  target: string | null;
  repeatMode: ReminderRepeatMode;
  intervalMinutes: number;
  nextFireAt: string;
  lastFiredAt: string | null;
  fireCount: number;
  createdAt: string;
}

/** One claimed, due row as the atomic UPDATE returns it (snake_case, new values). */
interface ClaimedReminderRow {
  id: string;
  user_id: string;
  alert_type: string;
  severity: string;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  target: string | null;
  dedupe_base: string | null;
  repeat_mode: string;
  fire_count: number;
}

/**
 * Repeating / one-time notification reminders
 * (`docs/specs/notification-preferences.md` Section 13).
 *
 * A reminder re-delivers one notification's subject on an interval until the
 * user stops it or its source is dismissed. Each fire re-emits through the ONE
 * write door (`NotificationService.create`) with a per-fire dedupe key, so every
 * re-delivery is a fresh in-app row -- the in-app channel is always written
 * (Section 3), and the push/email fan-out a repeat interrupts lands in Phase 5
 * on that same `create` call with no change here.
 *
 * The dependency is one-way -- this service uses `NotificationService`, never the
 * reverse -- so `NotificationCenterModule` stays the leaf it is documented to be.
 * Auto-stop-on-dismiss is done by the cron's own sweep rather than a call from
 * the dismiss path, for exactly that reason.
 */
@Injectable()
export class NotificationReminderService {
  private readonly logger = new Logger(NotificationReminderService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Create -- or re-configure -- a reminder for one of the caller's own live
   * notifications.
   *
   * The notification's content is read server-side from the source row (owned by
   * the caller) and copied into the template -- never taken from the request --
   * and the load and the write share one transaction so a source that vanishes
   * between the two cannot leave a reminder pointing at nothing.
   *
   * At most one ACTIVE reminder exists per (user, source): a second "remind me"
   * on the same notification re-configures the existing one rather than adding a
   * parallel nag (the `idx_notification_reminders_active_source` unique index is
   * the backstop against a concurrent double-submit). Only a genuinely new
   * reminder counts against the per-user cap.
   */
  async create(
    userId: string,
    dto: CreateNotificationReminderDto,
  ): Promise<NotificationReminderView> {
    const intervalMinutes = this.clampInterval(dto.intervalMinutes);

    const row = await withScopedDb(this.dataSource, async (manager) => {
      const source = await manager.getRepository(Notification).findOne({
        where: {
          id: dto.sourceNotificationId,
          userId,
          dismissedAt: IsNull(),
        },
      });
      if (!source) {
        // "Not yours" and "already dismissed" are the same answer, as on the
        // notification service: both mean there is nothing here to nag about.
        throw new NotFoundException(
          tr(
            "errors.notifications.notFound",
            `Notification with ID ${dto.sourceNotificationId} not found`,
            { id: dto.sourceNotificationId },
          ),
        );
      }

      try {
        return await this.upsertForSource(
          manager,
          userId,
          source,
          dto.repeatMode,
          intervalMinutes,
        );
      } catch (error) {
        // A concurrent create for the same source lost the unique-index race:
        // re-read the row the winner wrote and apply this caller's settings
        // (last write wins), rather than surfacing a 500.
        if (isActiveReminderConflict(error)) {
          return this.upsertForSource(
            manager,
            userId,
            source,
            dto.repeatMode,
            intervalMinutes,
          );
        }
        throw error;
      }
    });

    return toReminderView(row);
  }

  /**
   * Insert a reminder for this source, or re-configure the one active reminder
   * that already exists for it. The template is refreshed from the (current)
   * source on every call. A new row is subject to the per-user cap; a
   * re-configuration is not.
   */
  private async upsertForSource(
    manager: EntityManager,
    userId: string,
    source: Notification,
    repeatMode: ReminderRepeatMode,
    intervalMinutes: number,
  ): Promise<NotificationReminder> {
    const repo = manager.getRepository(NotificationReminder);
    const existing = await repo.findOne({
      where: {
        userId,
        sourceNotificationId: source.id,
        stoppedAt: IsNull(),
      },
    });

    const reminder = existing ?? new NotificationReminder();
    reminder.userId = userId;
    reminder.sourceNotificationId = source.id;
    reminder.type = source.type;
    reminder.severity = source.severity;
    reminder.title = source.title;
    reminder.message = source.message;
    reminder.data = source.data ?? {};
    reminder.target = source.target;
    // The source's own dedupe key names its subject where it has one (system
    // notifications), else its type -- the fire ordinal makes each re-emit
    // distinct regardless.
    reminder.dedupeBase = (source.dedupeKey ?? source.type).slice(
      0,
      DEDUPE_BASE_MAX_LENGTH,
    );
    reminder.repeatMode = repeatMode;
    reminder.intervalMinutes = intervalMinutes;
    // The source already delivered the first occurrence; the first nag comes one
    // interval later. A re-configure restarts the schedule and the fire count.
    reminder.nextFireAt = new Date(Date.now() + intervalMinutes * 60_000);
    reminder.fireCount = 0;
    reminder.stoppedAt = null;

    if (!existing) {
      const active = await repo.count({
        where: { userId, stoppedAt: IsNull() },
      });
      if (active >= MAX_ACTIVE_REMINDERS_PER_USER) {
        throw new BadRequestException(
          tr(
            "errors.notifications.tooManyReminders",
            `You can have at most ${MAX_ACTIVE_REMINDERS_PER_USER} active reminders. Stop one before adding another.`,
            { max: MAX_ACTIVE_REMINDERS_PER_USER },
          ),
        );
      }
    }

    return repo.save(reminder);
  }

  /** The caller's active reminders, newest first. */
  async list(userId: string): Promise<NotificationReminderView[]> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(NotificationReminder).find({
        where: { userId, stoppedAt: IsNull() },
        order: { createdAt: "DESC" },
      }),
    );
    return rows.map(toReminderView);
  }

  /**
   * Stop one reminder. Idempotent and ownership-scoped: stopping an already
   * stopped reminder, or one that is not the caller's, returns `{ stopped:
   * false }` rather than a 404 -- the push Stop action needs a call it can make
   * more than once, and distinguishing "not yours" from "already stopped" would
   * leak whether the id exists.
   */
  async stop(userId: string, id: string): Promise<{ stopped: boolean }> {
    const stopped = await withScopedDb(this.dataSource, (manager) =>
      this.stopByOwner(manager, userId, id),
    );
    return { stopped };
  }

  /**
   * Stop every reminder whose source notification is this one -- the door for a
   * producer that clears the underlying condition (the bill posts, the balance
   * recovers). Ownership is in the `WHERE`.
   */
  async stopRemindersFor(
    userId: string,
    sourceNotificationId: string,
  ): Promise<{ stopped: number }> {
    const stopped = await withScopedDb(
      this.dataSource,
      async (manager) =>
        returnedRows<{ id: string }>(
          await manager.query(
            `UPDATE notification_reminders
              SET stopped_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
              AND source_notification_id = $2
              AND stopped_at IS NULL
          RETURNING id`,
            [userId, sourceNotificationId],
          ),
        ).length,
    );
    return { stopped };
  }

  /**
   * Fire every due reminder, once per interval per replica-set.
   *
   * Every replica runs this, so the claim is a single conditional
   * `UPDATE ... RETURNING` (`docs/concurrency-and-idempotency.md`, atomic CAS):
   * it advances `next_fire_at` in the same statement that reads the row, so a
   * second replica's UPDATE blocks on the row lock, re-checks the `WHERE` against
   * the committed new value, and skips it -- each due row is claimed exactly
   * once. The claim commits BEFORE the re-emit, so a re-emit that fails skips
   * this occurrence and re-fires one interval later rather than risking a
   * double-fire.
   *
   * A `once` reminder is NOT stopped by the claim: consuming it here would commit
   * before the delivery, so a failed re-emit would lose the single follow-up with
   * no retry. It is stopped inside the same transaction that writes its
   * notification (`reEmit`), so the delivery and the stop cannot disagree --
   * a failure rolls back both and the next interval retries, delivering exactly
   * once.
   */
  @Cron("* * * * *")
  async fireDue(): Promise<void> {
    try {
      // Stop any reminder whose cause is gone, before the claim so it cannot be
      // claimed this tick. Two shapes: the source was dismissed, or the source
      // was deleted -- the FK is ON DELETE SET NULL, so a purged read-but-never-
      // dismissed source leaves the reminder orphaned (source_notification_id
      // NULL), and a nag with no live cause must not run forever. Every reminder
      // has a source today, so NULL means orphaned. A cross-user sweep, so it
      // seeds its own system context (task C2).
      await withSystemContext(() =>
        withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `UPDATE notification_reminders r
                SET stopped_at = CURRENT_TIMESTAMP
              WHERE r.stopped_at IS NULL
                AND (
                  r.source_notification_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM notifications n
                     WHERE n.id = r.source_notification_id
                       AND n.dismissed_at IS NOT NULL
                  )
                )`,
          ),
        ),
      );

      // Claim due rows atomically. next_fire_at is set to now + interval (not
      // previous + interval) so a cron that missed several ticks fires once and
      // reschedules, never a catch-up burst.
      const claimed = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) =>
          returnedRows<ClaimedReminderRow>(
            await manager.query(
              `UPDATE notification_reminders
                  SET next_fire_at = CURRENT_TIMESTAMP
                                     + (interval_minutes * INTERVAL '1 minute'),
                      last_fired_at = CURRENT_TIMESTAMP,
                      fire_count = fire_count + 1
                WHERE stopped_at IS NULL AND next_fire_at <= CURRENT_TIMESTAMP
              RETURNING id, user_id, alert_type, severity, title, message,
                        data, target, dedupe_base, repeat_mode, fire_count`,
            ),
          ),
        ),
      );

      if (claimed.length === 0) return;

      let fired = 0;
      for (const claim of claimed) {
        // Each re-emit is isolated: one user's failure must not skip the rest.
        try {
          await withUserContext(claim.user_id, () => this.reEmit(claim));
          fired += 1;
        } catch (error) {
          this.logger.error(
            `Failed to re-emit reminder ${claim.id}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }
      if (fired > 0) {
        this.logger.log(`Re-emitted ${fired} due reminder(s)`);
      }
    } catch (error) {
      this.logger.error(
        "Failed to fire due reminders",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /**
   * Re-emit one claimed reminder as a fresh in-app row through the write door,
   * and stop it in the SAME transaction when it is a one-shot.
   *
   * Runs under the caller's `withUserContext`. The write door's `create` opens a
   * nested `withScopedDb` that JOINS the outer one here, so the notification
   * INSERT and the `once` stop commit together: a failed delivery rolls back the
   * stop too, leaving the reminder claimable again next interval (it delivers
   * exactly once rather than being consumed on a transient failure).
   */
  private async reEmit(claim: ClaimedReminderRow): Promise<void> {
    const base = claim.dedupe_base ?? claim.alert_type;
    // `base:rem:<uuid>:<n>` -- the fire ordinal makes every re-emit distinct, so
    // ON CONFLICT DO NOTHING never swallows a nag against the still-live previous
    // one. Bounded to the column, dropping from the base rather than the ordinal
    // (the ordinal is what keeps it unique).
    const suffix = `:rem:${claim.id}:${claim.fire_count}`;
    const dedupeKey = `${base.slice(0, DEDUPE_KEY_MAX_LENGTH - suffix.length)}${suffix}`;

    await withScopedDb(this.dataSource, async (manager) => {
      await this.notifications.create(claim.user_id, {
        type: claim.alert_type as NotificationType,
        severity: claim.severity as NotificationSeverity,
        title: claim.title,
        message: claim.message,
        // The reminder id travels on the row so the bell can offer a Stop control
        // and the push (Phase 5) can carry the id its Stop action needs.
        data: { ...(claim.data ?? {}), reminderId: claim.id },
        target: claim.target,
        dedupeKey,
      });

      // A one-shot is stopped only once its follow-up is written, in this same
      // transaction. Guarded on `stopped_at IS NULL` so a concurrent stop (the
      // app, or the source-dismissed sweep) is not clobbered.
      if (claim.repeat_mode === ReminderRepeatMode.ONCE) {
        await manager.query(
          `UPDATE notification_reminders
              SET stopped_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2 AND stopped_at IS NULL`,
          [claim.id, claim.user_id],
        );
      }
    });
  }

  /** One place the stop UPDATE lives, so `stop` and any future caller agree. */
  private async stopByOwner(
    manager: EntityManager,
    userId: string,
    id: string,
  ): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(
      await manager.query(
        `UPDATE notification_reminders
            SET stopped_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2 AND stopped_at IS NULL
        RETURNING id`,
        [id, userId],
      ),
    );
    return rows.length > 0;
  }

  private clampInterval(minutes: number): number {
    return Math.min(
      REMINDER_MAX_INTERVAL_MINUTES,
      Math.max(REMINDER_MIN_INTERVAL_MINUTES, Math.round(minutes)),
    );
  }
}

/** The unique index that keeps one active reminder per (user, source). */
const ACTIVE_SOURCE_INDEX = "idx_notification_reminders_active_source";

/**
 * A unique-violation on the active-per-source index, and only that -- so a
 * concurrent double-submit is recovered by re-reading and updating the winner's
 * row, while any other error still surfaces. Scoped to the index name rather
 * than a bare 23505, so a different constraint is never mistaken for this one.
 */
function isActiveReminderConflict(error: unknown): boolean {
  const wrapped = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
    driverError?: { code?: unknown; constraint?: unknown; message?: unknown };
  };
  const code = wrapped?.code ?? wrapped?.driverError?.code;
  if (code !== "23505") return false;
  const constraint = wrapped?.constraint ?? wrapped?.driverError?.constraint;
  const message = `${wrapped?.message ?? ""} ${wrapped?.driverError?.message ?? ""}`;
  return (
    constraint === ACTIVE_SOURCE_INDEX || message.includes(ACTIVE_SOURCE_INDEX)
  );
}

function toReminderView(row: NotificationReminder): NotificationReminderView {
  return {
    id: row.id,
    sourceNotificationId: row.sourceNotificationId,
    type: row.type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    target: row.target,
    repeatMode: row.repeatMode,
    intervalMinutes: row.intervalMinutes,
    nextFireAt: new Date(row.nextFireAt).toISOString(),
    lastFiredAt: row.lastFiredAt
      ? new Date(row.lastFiredAt).toISOString()
      : null,
    fireCount: row.fireCount,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
