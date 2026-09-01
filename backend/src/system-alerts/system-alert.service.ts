import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { I18nService } from "nestjs-i18n";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { EmailService } from "../notifications/email.service";
import { systemAlertTemplate } from "../notifications/email-templates";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  AdminRecipient,
  queryAdminRecipients,
} from "../users/admin-recipients.util";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";

/** Matches notifications.dedupe_key VARCHAR(120). */
export const DEDUPE_KEY_MAX_LENGTH = 120;

/** Matches notifications.title VARCHAR(255). */
export const TITLE_MAX_LENGTH = 255;

export interface SystemAlertInput {
  type: NotificationType;
  severity: NotificationSeverity;
  /** Stored English fallback; the client composes localized copy from `data`. */
  title: string;
  /** Stored English fallback; the client composes localized copy from `data`. */
  message: string;
  /** Facts for client-side localization. Include `system: true`; never store a
   *  value that goes stale while the row lives. */
  data: Record<string, unknown>;
  /**
   * Explicit fingerprint, unique per recipient via `idx_notifications_dedupe`
   * -- the cross-replica arbiter for both the row and its email. At most
   * `DEDUPE_KEY_MAX_LENGTH` characters.
   */
  dedupeKey: string;
  /**
   * Whether the insert winners also email. Defaults to true for critical and
   * warning severities. Forced off for `SMTP_FAILURE` whatever the caller
   * says: the email channel cannot report its own failure.
   */
  email?: boolean;
  /**
   * Collapses the EMAIL (never the rows) of several alerts that share one
   * cause onto a single message per administrator, claimed through
   * `job_claims`. Without it every raise that wins its row also emails, which
   * is right for a deployment-wide fact raised once -- and wrong for a
   * per-user one: a full disk on a sixty-user install raises sixty
   * BACKUP_FAILED rows, each correctly naming its user, and would otherwise
   * send sixty emails per administrator about one broken volume. The rows
   * stay granular; the mail says it once.
   */
  emailDedupeKey?: string;
}

/**
 * Raises system-level issues (a failed backup, a missing encryption key, a
 * provider outage) as rows in the existing alerts interface -- the
 * `notifications` table behind the bell dropdown -- and, for admin alerts that
 * warrant it, as an email to the administrators.
 *
 * **Fan-out**: `notifications` is RLS-keyed on `user_id`, so a deployment-wide
 * fact is materialized as one row per administrator, each independently
 * readable and dismissible. The recipient predicate is
 * `queryAdminRecipients` (`users/admin-recipients.util.ts`), shared with
 * `ProviderOutageAlertService`.
 *
 * **At-most-once**: every replica runs every cron, so each insert carries a
 * `dedupe_key` and lands as `INSERT ... ON CONFLICT DO NOTHING RETURNING id`
 * against the partial unique index `idx_notifications_dedupe`
 * (migration 170). Only the insert winner's rows email -- the same trade as
 * `ProviderOutageAlertService`: a process killed between the insert
 * committing and SMTP accepting loses that email, the in-app row survives,
 * and a duplicated admin alert is the failure mode designed against
 * (INV-ALERT-001, `docs/specs/system-alerts.md`).
 *
 * **Context**: both entry points seed their own RLS context
 * (`withSystemContext` for the admin fan-out, `withUserContext` for a
 * per-user alert), because every caller is a cron catch, a post-claim hook or
 * a bootstrap hook with no request behind it. Callers must invoke this
 * OUTSIDE any open `withScopedDb` transaction: a nested call would join the
 * caller's transaction under the caller's identity GUCs, and an alert about a
 * failure must not roll back with the work that failed.
 *
 * **Never throws**: an alert is a side reporting channel. A failure to raise
 * one is logged and swallowed so it cannot end the sweep that noticed the
 * original problem.
 */
@Injectable()
export class SystemAlertService {
  private readonly logger = new Logger(SystemAlertService.name);

  /** Whether "no administrator to alert" has been logged since one existed. */
  private noAdminsReported = false;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
    private readonly i18n: I18nService,
    private readonly jobClaims: JobClaimService,
  ) {}

  /**
   * Fan an admin-facing system alert out to every active administrator, and
   * email the insert winners' recipients where the severity (or the caller)
   * asks for it.
   */
  async raiseAdminAlert(
    input: SystemAlertInput,
  ): Promise<{ created: number; emailed: number }> {
    try {
      return await withSystemContext(() => this.fanOutToAdmins(input));
    } catch (error) {
      this.logger.error(
        `Could not raise ${input.type} admin alert: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { created: 0, emailed: 0 };
    }
  }

  /**
   * Raise a system alert for one affected user (e.g. their scheduled
   * transaction failed to post). In-app only -- no email on this path.
   */
  async raiseUserAlert(
    userId: string,
    input: Omit<SystemAlertInput, "email">,
  ): Promise<{ created: boolean }> {
    try {
      const id = await withUserContext(userId, () =>
        this.insertAlert(userId, input),
      );
      return { created: id !== null };
    } catch (error) {
      this.logger.error(
        `Could not raise ${input.type} alert for user ${userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { created: false };
    }
  }

  private async fanOutToAdmins(
    input: SystemAlertInput,
  ): Promise<{ created: number; emailed: number }> {
    const admins = await withScopedDb(this.dataSource, (manager) =>
      queryAdminRecipients(manager),
    );
    if (admins.length === 0) {
      this.reportNoAdmins(input.type);
      return { created: 0, emailed: 0 };
    }
    this.noAdminsReported = false;

    const shouldEmail = this.shouldEmail(input);
    let created = 0;
    let emailed = 0;
    for (const admin of admins) {
      // Each admin's row and email are isolated: one failing recipient must
      // not cost the others their alert.
      try {
        const rowId = await this.insertAlert(admin.userId, input);
        if (rowId === null) continue;
        created += 1;
        const email = admin.email;
        if (
          shouldEmail &&
          admin.emailEnabled &&
          email !== null &&
          (await this.claimEmail(admin.userId, input))
        ) {
          const sent = await this.emailAdmin({ ...admin, email }, input);
          if (sent) {
            emailed += 1;
            await this.markEmailSent(rowId);
          }
        }
      } catch (error) {
        this.logger.error(
          `Could not deliver ${input.type} alert to admin ${admin.userId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { created, emailed };
  }

  /**
   * One guarded insert. `null` means another replica (or an earlier run in the
   * same dedupe bucket) already holds this alert for this recipient.
   */
  private async insertAlert(
    userId: string,
    input: Omit<SystemAlertInput, "email">,
  ): Promise<string | null> {
    const rows = returnedRows<{ id: string }>(
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO notifications
             (user_id, alert_type, severity, title, message, data,
              period_start, dedupe_key)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
             DO NOTHING
           RETURNING id`,
          [
            userId,
            input.type,
            input.severity,
            boundedTitle(input.title),
            input.message,
            JSON.stringify(input.data ?? {}),
            todayIsoDate(),
            this.boundedDedupeKey(input),
          ],
        ),
      ),
    );
    return rows[0]?.id ?? null;
  }

  private async markEmailSent(alertId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE notifications SET is_email_sent = true WHERE id = $1`,
        [alertId],
      ),
    );
  }

  /**
   * One admin's email, rendered in their own locale. Returns whether SMTP
   * accepted it; a refusal (or SMTP being unconfigured) costs this recipient
   * their email and nobody else theirs -- the in-app row already exists.
   */
  private async emailAdmin(
    admin: AdminRecipient & { email: string },
    input: SystemAlertInput,
  ): Promise<boolean> {
    if (!this.emailService.getStatus().configured) return false;
    try {
      const lang = await withScopedDb(this.dataSource, (manager) =>
        resolveUserEmailLocale(
          manager.getRepository(UserPreference),
          admin.userId,
        ),
      );
      const t = emailTranslator(this.i18n, lang);
      const html = systemAlertTemplate(
        admin.firstName,
        {
          severity: input.severity,
          title: input.title,
          message: input.message,
        },
        t,
      );
      const subject = t(
        "emails.systemAlert.subject",
        `Monize: ${input.title}`,
        {
          title: input.title,
        },
      );
      await this.emailService.sendMail(admin.email, subject, html);
      return true;
    } catch (error) {
      this.logger.error(
        `Could not email ${input.type} alert to admin ${admin.userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Whether this administrator is owed the email, when the caller asked for
   * several same-cause alerts to share one.
   *
   * `claimOnce` is the same cross-replica arbiter the reminders use: the one
   * caller whose INSERT lands gets `true`, every later raise in the bucket
   * (and every other replica) gets `false`. A claim failure must not cost the
   * alert its mail, so an error here falls through to sending -- a duplicate
   * email is the lesser of the two outcomes once the row already exists.
   */
  private async claimEmail(
    adminUserId: string,
    input: SystemAlertInput,
  ): Promise<boolean> {
    if (input.emailDedupeKey === undefined) return true;
    try {
      return await this.jobClaims.claimOnce(
        JobClaimType.SystemAlertEmail,
        adminUserId,
        input.emailDedupeKey.slice(0, DEDUPE_KEY_MAX_LENGTH),
      );
    } catch (error) {
      this.logger.error(
        `Could not claim the ${input.type} email for admin ${adminUserId}; ` +
          `sending it rather than losing it: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  /**
   * Whether this alert's insert winners email. `SMTP_FAILURE` never does,
   * whatever the caller says: the report that email is broken cannot travel
   * by email, and an attempt would land in the failure snapshot it was
   * raised from.
   */
  private shouldEmail(input: SystemAlertInput): boolean {
    if (input.type === NotificationType.SMTP_FAILURE) return false;
    if (input.email !== undefined) return input.email;
    return (
      input.severity === NotificationSeverity.CRITICAL ||
      input.severity === NotificationSeverity.WARNING
    );
  }

  /**
   * Keys are bounded by construction (type + UUID + date is well under the
   * column); a longer one is a caller bug, reported and truncated
   * deterministically rather than thrown, because the alert still deduping --
   * slightly too coarsely -- beats the sweep that raised it dying here.
   */
  private boundedDedupeKey(input: Omit<SystemAlertInput, "email">): string {
    if (input.dedupeKey.length <= DEDUPE_KEY_MAX_LENGTH) return input.dedupeKey;
    this.logger.error(
      `Dedupe key for ${input.type} exceeds ${DEDUPE_KEY_MAX_LENGTH} chars ` +
        `and was truncated: ${input.dedupeKey.slice(0, 60)}...`,
    );
    return input.dedupeKey.slice(0, DEDUPE_KEY_MAX_LENGTH);
  }

  /** Say once that there is nobody to tell, not once per sweep. */
  private reportNoAdmins(type: NotificationType): void {
    if (this.noAdminsReported) return;
    this.noAdminsReported = true;
    this.logger.warn(
      `A ${type} system alert had no active administrator to go to; nobody ` +
        "was told. It is raised again once an administrator exists.",
    );
  }
}

/**
 * A title the `title VARCHAR(255)` column will accept.
 *
 * Producers interpolate names they do not control -- a scheduled
 * transaction's, an account's -- and an over-long one makes PostgreSQL raise
 * 22001, which the never-throws contract then swallows: the alert silently
 * never exists, and for SCHEDULED_POST_FAILED that means the user is never
 * told their money did not move. Truncating is the honest failure here, and
 * it happens once, at the door, rather than at each producer.
 */
function boundedTitle(title: string): string {
  if (title.length <= TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TITLE_MAX_LENGTH - 1)}\u2026`;
}

/** Today as the DATE the NOT NULL period_start column requires. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
