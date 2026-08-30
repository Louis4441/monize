import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import {
  AlertSeverity,
  AlertType,
} from "../budgets/entities/budget-alert.entity";
import {
  ENCRYPTION_KEY_ENV,
  resolveEncryptionKey,
} from "../common/encryption/encryption-key";
import { EmailService } from "../notifications/email.service";
import { SystemAlertService } from "./system-alert.service";

/**
 * A failure older than this cannot raise a fresh SMTP alert: with a quiet
 * outbox nothing has failed *lately*, and the last alert about the broken
 * spell already exists (one per day via the dedupe key).
 */
export const SMTP_FAILURE_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Watches for deployment states nobody currently reports and raises them as
 * admin system alerts:
 *
 * - **Missing encryption key** (issue #1269's silent state), re-raised once
 *   per ISO week while it stays unset. The startup log warning in `main.ts`
 *   stays; this is the in-app copy an operator who never reads container logs
 *   actually sees.
 *
 *   Deliberately on the sweep rather than on `onApplicationBootstrap`, for
 *   three reasons that all bit the boot-time version: a fresh install has no
 *   administrator yet when it boots, so the fan-out stood down and the alert
 *   was never raised until somebody restarted the server; a deployment that
 *   simply keeps running never re-raised it, contradicting the weekly bucket
 *   it is keyed on; and Nest awaits bootstrap hooks inside `app.listen()`, so
 *   an unreachable relay delayed the port opening by one SMTP timeout per
 *   administrator and could hold a readiness probe into a restart loop. A
 *   condition that has been true since installation can wait fifteen minutes.
 * - **SMTP delivery failing**: a 15-minute sweep over this replica's own
 *   `EmailService` failure snapshot. In-app only by definition -- the email
 *   channel cannot report itself. Skipped entirely when SMTP is not
 *   configured: unconfigured is a setup state announced at boot, not a
 *   failure.
 *
 * No database access of its own -- `SystemAlertService` seeds its own RLS
 * context -- so this file does not need the with-context lint allowlist.
 */
@Injectable()
export class SystemAlertMonitorService {
  private readonly logger = new Logger(SystemAlertMonitorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly systemAlerts: SystemAlertService,
    @Inject(forwardRef(() => EmailService))
    private readonly emailService: EmailService,
  ) {}

  /**
   * Both checks, on one schedule. Each is independent: the encryption key is
   * a fact about configuration, SMTP health a fact about the last sends, and
   * neither may stop the other from being reported.
   */
  @Cron("*/15 * * * *")
  async sweepSystemHealth(now: Date = new Date()): Promise<void> {
    await this.checkEncryptionKey(now);
    await this.sweepEmailHealth(now);
  }

  /** `raiseAdminAlert` never throws, so nor does this. */
  async checkEncryptionKey(now: Date = new Date()): Promise<void> {
    const resolved = resolveEncryptionKey((name) =>
      this.configService.get<string>(name),
    );
    if (resolved !== null) return;

    await this.systemAlerts.raiseAdminAlert({
      type: AlertType.ENCRYPTION_KEY_MISSING,
      severity: AlertSeverity.WARNING,
      title: "Encryption key not configured",
      message:
        `${ENCRYPTION_KEY_ENV} is not set. Backups are written unencrypted ` +
        "and secrets (AI provider keys, emergency access) cannot be stored. " +
        "A future release will refuse to start without it.",
      data: { system: true },
      dedupeKey: `ENCRYPTION_KEY_MISSING:${isoWeekBucket(now)}`,
    });
  }

  async sweepEmailHealth(now: Date = new Date()): Promise<void> {
    if (!this.emailService.getStatus().configured) return;
    const snapshot = this.emailService.getFailureSnapshot();
    if (snapshot.lastFailureAt === null) return;
    // A success after the last failure means delivery recovered on its own.
    if (
      snapshot.lastSuccessAt !== null &&
      snapshot.lastSuccessAt.getTime() > snapshot.lastFailureAt.getTime()
    ) {
      return;
    }
    if (
      now.getTime() - snapshot.lastFailureAt.getTime() >
      SMTP_FAILURE_LOOKBACK_MS
    ) {
      return;
    }

    await this.systemAlerts.raiseAdminAlert({
      type: AlertType.SMTP_FAILURE,
      severity: AlertSeverity.WARNING,
      title: "Email delivery is failing",
      message:
        `Monize could not send email: ${snapshot.lastFailureMessage ?? "unknown error"}. ` +
        "Notifications and reminders are not being delivered.",
      data: {
        system: true,
        lastError: snapshot.lastFailureMessage,
        failuresSinceSuccess: snapshot.failuresSinceSuccess,
        lastFailureAt: snapshot.lastFailureAt.toISOString(),
      },
      dedupeKey: `SMTP_FAILURE:${now.toISOString().slice(0, 10)}`,
      // Belt and braces: SystemAlertService forces this off for SMTP_FAILURE
      // anyway, but the intent belongs at the call site too.
      email: false,
    });
  }
}

/**
 * `2026-W35` -- the ISO 8601 week the date falls in, computed in UTC. The
 * dedupe bucket for a persistent condition checked on every boot: stable
 * across replicas and restarts within a week, fresh the week after.
 */
export function isoWeekBucket(date: Date): string {
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(
    ((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7,
  );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
