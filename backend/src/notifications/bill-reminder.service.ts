import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { expandOccurrenceSlots } from "../common/scheduled-occurrences";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { UserPreference } from "../users/entities/user-preference.entity";
import { User } from "../users/entities/user.entity";
import { EmailService } from "./email.service";
import { billReminderTemplate } from "./email-templates";
import { emailTranslator } from "../i18n/email-translator";
import { DEFAULT_LOCALE } from "../i18n/config";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { withScopedDb } from "../common/db/scoped-db";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";
import { createHash } from "node:crypto";

/**
 * How long one replica holds the right to send this user's bill reminder.
 *
 * A lease, so a replica killed between claiming and sending costs a retry window
 * rather than the delivery. It only has to outlast an SMTP round trip; whether the
 * work is still owed is decided by the delivery record, not by the lease
 * (audit RV4-006).
 *
 * The resulting contract is at-least-once: a process killed after SMTP accepted
 * but before the record committed re-sends next run. For a reminder that is the
 * right trade -- a duplicate nudge is an annoyance, a missed mortgage renewal is
 * not. See docs/cron-jobs.md.
 */
const REMINDER_LEASE_MS = 10 * 60 * 1000;

@Injectable()
export class BillReminderService {
  private readonly logger = new Logger(BillReminderService.name);

  constructor(
    private dataSource: DataSource,
    private emailService: EmailService,
    private configService: ConfigService,
    private readonly i18n: I18nService,
    private readonly jobClaims: JobClaimService,
    // Which occurrence is due, when it falls and what it will cost -- all from
    // the one server-side occurrence contract rather than the persisted snapshot
    // or a private copy of the override rules (issue #1247).
    @Inject(forwardRef(() => ScheduledOccurrenceService))
    private readonly occurrences: ScheduledOccurrenceService,
  ) {}

  /**
   * Release a lease a send did not use, so the next run can retry.
   *
   * Addressed by the lease token, not only by the work: a stalled worker must not
   * delete a lease another replica has retaken (audit DR-RRV4-01).
   */
  private async releaseClaim(
    userId: string,
    claimKey: string,
    leaseToken: string,
  ): Promise<void> {
    await this.jobClaims
      .releaseLease(JobClaimType.BillReminder, userId, claimKey, leaseToken)
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed to release bill-reminder claim for user ${userId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendBillReminders(): Promise<void> {
    if (!this.emailService.getStatus().configured) {
      this.logger.debug("SMTP not configured, skipping bill reminders");
      return;
    }

    this.logger.log("Running bill reminder check...");

    // Only manual bills (autoPost = false) that are active.
    // RLS (task C2): cross-user fan-out over every user's manual bills.
    const manualBills = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(ScheduledTransaction).find({
          where: { isActive: true, autoPost: false },
          // `splits` is what tells the effective-amount resolver whether a
          // schedule's cash total re-prices at the current FX rate (issue
          // #1247); without it an embedded-investment schedule looks fixed.
          relations: ["payee", "overrides", "splits"],
        }),
      ),
    );

    if (manualBills.length === 0) {
      this.logger.log("No manual bills found");
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Group bills by userId where due date is within reminderDaysBefore window
    const billsByUser = new Map<string, ScheduledTransaction[]>();

    const todayStr = todayYMD();
    for (const bill of manualBills) {
      // "Is this bill due inside its own reminder window" is a question about an
      // OCCURRENCE, so it is asked through the one expander: the override that
      // matters is the one on the recurrence slot, and it may have moved the
      // occurrence's date (issue #1247). This half runs cross-user, so it cannot
      // price anything -- `deliverForUser` does that under the owner's identity.
      const due = expandOccurrenceSlots(bill, bill.overrides ?? [], {
        from: todayStr,
        through: addDaysYMD(todayStr, bill.reminderDaysBefore),
        maxOccurrences: 1,
      });
      if (due.length > 0) {
        const existing = billsByUser.get(bill.userId) || [];
        existing.push(bill);
        billsByUser.set(bill.userId, existing);
      }
    }

    if (billsByUser.size === 0) {
      this.logger.log("No bills due within reminder windows");
      return;
    }

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    let sentCount = 0;
    let skipCount = 0;

    for (const [userId, bills] of billsByUser) {
      // The whole per-user body runs under this user's identity, claims
      // included.
      //
      // `JobClaimService` reaches the database through `withScopedDb` like any
      // other caller, so it needs an ambient context to spend -- and the
      // `withSystemContext` above covers only the cross-user fan-out read. With
      // the claims left outside a context, `withScopedDb` threw
      // `MISSING_CONTEXT_MESSAGE` on the first user with a due bill and, because
      // the throw was outside the try, took the rest of the run with it: no
      // reminder was sent to anybody. Wrapping the body is what makes the claim,
      // the delivery record and the release share one identity with the reads
      // between them.
      const sent = await withUserContext(userId, () =>
        this.deliverForUser(userId, bills, appUrl),
      );
      if (sent) sentCount++;
      else skipCount++;
    }

    this.logger.log(
      `Bill reminders complete: ${sentCount} sent, ${skipCount} skipped`,
    );
  }

  /**
   * Claim, send and record one user's bill reminder. Returns whether an email
   * was sent, so the caller can count it.
   *
   * Runs inside the caller's `withUserContext`: every database call below, the
   * job claims included, spends that identity.
   */
  private async deliverForUser(
    userId: string,
    bills: readonly ScheduledTransaction[],
    appUrl: string,
  ): Promise<boolean> {
    // Claim this user's reminder for today before doing anything that leaves
    // the process.
    //
    // Every backend replica fires this cron (docs/cron-jobs.md), and nothing
    // here recorded that a reminder had been sent -- so two healthy replicas
    // both selected the same due bills and both emailed them. Not a rare race:
    // the *normal* outcome of running more than one replica (audit P4-018).
    //
    // The key is the local date plus a hash of what the email says, so a bill
    // that becomes due later the same day still produces a reminder while an
    // identical run does not.
    const claimKey = buildReminderClaimKey(bills);
    // A **lease**, not a permanent claim, plus a durable delivery record.
    //
    // `claimOnce` was taken before the send and was the only record that the
    // send was owed, so a replica killed in between left a permanent row that
    // every later run read as "already handled" -- the bill reminder was never
    // sent and nothing could notice, because the row could not tell "I sent
    // this" from "I intended to" (audit RV4-006). The lease bounds *doing* the
    // work; `delivered_at`, written after the send and re-read here, is what
    // says it was done.
    const claimed = await this.jobClaims.claimLease(
      JobClaimType.BillReminder,
      userId,
      claimKey,
      REMINDER_LEASE_MS,
    );
    if (!claimed) {
      return false;
    }
    const leaseToken = claimed;
    if (
      await this.jobClaims.wasDelivered(
        JobClaimType.BillReminder,
        userId,
        claimKey,
      )
    ) {
      // Already sent, durably. Hand the lease back rather than holding it for
      // its whole TTL.
      await this.releaseClaim(userId, claimKey, leaseToken);
      return false;
    }

    try {
      // Check if user has email notifications enabled.
      // RLS (task C2): per-user reads run under the user's own context.
      const prefs = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(UserPreference).findOne({
          where: { userId },
        }),
      );
      if (prefs && !prefs.notificationEmail) {
        await this.releaseClaim(userId, claimKey, leaseToken);
        return false;
      }

      const user = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(User).findOne({ where: { id: userId } }),
      );
      if (!user || !user.email) {
        await this.releaseClaim(userId, claimKey, leaseToken);
        return false;
      }

      // What each occurrence would actually post, and when, from the one
      // server-side occurrence contract (issue #1247). The persisted `amount` is
      // a snapshot at whatever rate was current when it was written, so a
      // reminder built from it can name a figure the posting will not use -- and
      // the occurrence the user re-dated is not the one the template describes.
      // The direction (income vs expense) still comes from the stored sign: an
      // FX rate is positive, so it cannot flip one, and the sign is known even
      // when the magnitude is not.
      const todayStr = todayYMD();
      const longestWindow = Math.max(
        ...bills.map((b) => b.reminderDaysBefore ?? 0),
        0,
      );
      const occurrences = await this.occurrences.expand(userId, [...bills], {
        from: todayStr,
        through: addDaysYMD(todayStr, longestWindow),
        maxOccurrences: 1,
      });
      const billData = occurrences.map((occurrence) => {
        const b = occurrence.schedule;
        return {
          payee: b.payee?.name || b.payeeName || b.name,
          amount:
            occurrence.amount === null ? null : Math.abs(occurrence.amount),
          dueDate: occurrence.dueDate,
          currencyCode: occurrence.currencyCode,
          isIncome: (occurrence.amount ?? Number(b.amount)) > 0,
        };
      });

      const lang = prefs?.language || DEFAULT_LOCALE;
      const t = emailTranslator(this.i18n, lang);
      const html = billReminderTemplate(
        user.firstName || "",
        billData,
        appUrl,
        t,
      );
      const subject =
        bills.length === 1
          ? t(
              "emails.billReminder.subjectOne",
              "Monize: 1 upcoming bill needs attention",
            )
          : t(
              "emails.billReminder.subjectMany",
              `Monize: ${bills.length} upcoming bills need attention`,
              { count: bills.length },
            );

      await this.emailService.sendMail(user.email, subject, html);
      // The delivery record, after the side effect and never before it.
      await this.jobClaims.markDelivered(
        JobClaimType.BillReminder,
        userId,
        claimKey,
        leaseToken,
      );
      return true;
    } catch (error) {
      // Hand the claim back. Claiming first is what makes the send
      // exactly-once, but it must not turn a transient SMTP outage into a
      // silently skipped day -- which is what the pre-claim code got for free
      // by never recording anything.
      await this.releaseClaim(userId, claimKey, leaseToken);
      this.logger.error(
        `Failed to send bill reminder to user ${userId}`,
        error instanceof Error ? error.stack : error,
      );
      return false;
    }
  }
}

/**
 * The delivery key for one user's bill reminder: today's date plus a digest of
 * exactly what the email will say.
 *
 * The date alone would suppress a legitimate second reminder when another bill
 * falls due later the same day. The digest alone would let the same set be
 * re-sent tomorrow. Together they mean "this reminder, today", which is what the
 * claim is asserting.
 */
export function buildReminderClaimKey(
  bills: readonly ScheduledTransaction[],
): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const fingerprint = [...bills]
    .map((b) => `${b.id}:${String(b.nextDueDate).split("T")[0]}:${b.amount}`)
    .sort()
    .join("|");
  const digest = createHash("sha256")
    .update(fingerprint)
    .digest("hex")
    .slice(0, 32);
  return `${date}#${digest}`;
}
