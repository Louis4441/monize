import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import {
  JwtSecretWeakness,
  jwtSecretWeakness,
} from "../common/jwt-secret-policy";
import {
  EmailFailureSnapshot,
  EmailService,
} from "../notifications/email.service";
import { NOTIFICATION_EMAIL_MESSAGES } from "../notifications/notification-email-messages";
import { SystemAlertService } from "./system-alert.service";

/**
 * A failure older than this cannot raise a fresh SMTP alert: with a quiet
 * outbox nothing has failed *lately*, and the last alert about the broken
 * spell already exists (one per day via the dedupe key).
 */
export const SMTP_FAILURE_LOOKBACK_MS = 24 * 60 * 60_000;

/** The admin-only deployment status: configuration an administrator must fix. */
export interface DeploymentStatus {
  /** Why `JWT_SECRET` is weak, or `null` when it is not. */
  jwtSecretWeakness: JwtSecretWeakness | null;
}

/**
 * Watches for deployment states nobody currently reports and raises them as
 * admin system alerts:
 *
 * - **Weak `JWT_SECRET`** (a published placeholder or a typed pattern that
 *   is long enough to boot), re-raised once per ISO week while it stays. The
 *   startup log warning in `main.ts` stays; this is the in-app copy an
 *   operator who never reads container logs actually sees, and the admin
 *   banner (`GET /admin/deployment-status`) is the third.
 *
 *   The missing-`ENCRYPTION_KEY` alert this sweep used to raise is gone: the
 *   server now refuses to start without a key (`checkClusterBoot`), so the
 *   state cannot be observed from a running process. The
 *   `ENCRYPTION_KEY_MISSING` type stays for the rows already raised.
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
 *   `EmailService` failure snapshot, confirmed by a live probe. The sweep is
 *   per replica by construction -- the snapshot is in-process memory with no
 *   durable home -- so a recorded failure is only a reason to look: before
 *   raising, the sweep calls `EmailService.verifyConnection()` (a connect,
 *   TLS and login without a message; production code never called it before
 *   this sweep) and raises only when that probe fails too. "Failing" then
 *   means "this replica cannot reach the relay now", which is true and
 *   actionable under any number of replicas; a stale memory of one failed
 *   send on one replica, after SMTP recovered and the others kept sending,
 *   no longer raises it for the whole deployment. A replica with no failure
 *   recorded is never probed. In-app only by definition -- the email channel
 *   cannot report itself. Skipped entirely when SMTP is not configured:
 *   unconfigured is a setup state announced at boot, not a failure.
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
   * Both checks, on one schedule. Each is independent: the signing secret is
   * a fact about configuration, SMTP health a fact about whether this replica
   * can reach the relay now, and neither may stop the other from being
   * reported.
   */
  @Cron("*/15 * * * *")
  async sweepSystemHealth(now: Date = new Date()): Promise<void> {
    await this.checkJwtSecret(now);
    await this.sweepEmailHealth(now);
  }

  /**
   * What the admin banner needs to know about this deployment's configuration.
   * A reason code only: never the secret, nor anything derived from it.
   * Read by `GET /admin/deployment-status`, through the same rule as the alert
   * below, so the banner and the alert cannot disagree.
   */
  getDeploymentStatus(): DeploymentStatus {
    return {
      jwtSecretWeakness:
        jwtSecretWeakness(this.configService.get<string>("JWT_SECRET"))
          ?.reason ?? null,
    };
  }

  /**
   * Raise the weak-`JWT_SECRET` alert while the secret stays weak. The rule is
   * `jwtSecretWeakness`, the one the boot warning and the admin banner read,
   * and the alert carries only its reason code: never the secret or any part
   * of it. `raiseAdminAlert` never throws, so nor does this.
   */
  async checkJwtSecret(now: Date = new Date()): Promise<void> {
    const weakness = jwtSecretWeakness(
      this.configService.get<string>("JWT_SECRET"),
    );
    if (weakness === null) return;

    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.JWT_SECRET_WEAK,
      severity: NotificationSeverity.WARNING,
      // The stored English fallback is the catalog's own English, so the row
      // and the localized copy cannot say different things.
      title: NOTIFICATION_EMAIL_MESSAGES["system.jwtSecretWeak.title"],
      message: NOTIFICATION_EMAIL_MESSAGES["system.jwtSecretWeak.message"],
      data: { system: true, reason: weakness.reason },
      dedupeKey: `JWT_SECRET_WEAK:${isoWeekBucket(now)}`,
    });
  }

  /**
   * Raise `SMTP_FAILURE` when this replica recorded a transport failure in the
   * lookback with no success since AND a probe of the relay fails now. The
   * probe runs only once the snapshot already says "failing", so a healthy
   * replica sends no traffic on the sweep's behalf.
   */
  async sweepEmailHealth(now: Date = new Date()): Promise<void> {
    if (!this.emailService.getStatus().configured) return;
    const snapshot = this.emailService.getFailureSnapshot();
    if (snapshot.lastFailureAt === null) return;
    // A success after the last failure means delivery recovered on its own.
    if (succeededSinceFailure(snapshot)) return;
    if (
      now.getTime() - snapshot.lastFailureAt.getTime() >
      SMTP_FAILURE_LOOKBACK_MS
    ) {
      return;
    }

    // The snapshot is a memory of this replica's last sends; ask the relay
    // whether the failure is still true before telling every administrator
    // so. The probe records its own outcome, so re-read the snapshot: a
    // success there (the probe's, or a send that landed meanwhile) wins.
    const reachable = await this.emailService.verifyConnection();
    const fresh = this.emailService.getFailureSnapshot();
    if (reachable || succeededSinceFailure(fresh)) return;

    const lastError = fresh.lastFailureMessage ?? snapshot.lastFailureMessage;
    const lastFailureAt = fresh.lastFailureAt ?? snapshot.lastFailureAt;
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.SMTP_FAILURE,
      severity: NotificationSeverity.WARNING,
      title: "Email delivery is failing",
      message:
        // The same sentence as the localized catalog entry
        // (`system.smtpFailure.message`), so the stored row and the rendered
        // copy cannot disagree; the probe's verdict travels in `data`.
        `Monize could not send email: ${lastError ?? "unknown error"}. ` +
        "Notifications and reminders are not being delivered.",
      data: {
        system: true,
        probe: "failed",
        lastError,
        failuresSinceSuccess: fresh.failuresSinceSuccess,
        lastFailureAt: lastFailureAt.toISOString(),
      },
      dedupeKey: `SMTP_FAILURE:${now.toISOString().slice(0, 10)}`,
      // Belt and braces: SystemAlertService forces this off for SMTP_FAILURE
      // anyway, but the intent belongs at the call site too.
      email: false,
    });
  }
}

/** Whether a success was recorded after the last transport failure. */
function succeededSinceFailure(snapshot: EmailFailureSnapshot): boolean {
  return (
    snapshot.lastFailureAt !== null &&
    snapshot.lastSuccessAt !== null &&
    snapshot.lastSuccessAt.getTime() > snapshot.lastFailureAt.getTime()
  );
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
