import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";

/**
 * What this replica's own SMTP sends have done lately. Purely in-process --
 * the `SMTP_FAILURE` system alert that reads it dedupes across replicas at the
 * database, so per-replica memory is enough -- and only about *configured*
 * transport failures: an unconfigured deployment throws before the snapshot
 * and is a setup state, not a failure.
 *
 * A **recipient rejection is not a transport failure** and is counted
 * separately. `sendMail` rejects for both, but they are opposite facts: a
 * `550 mailbox full` means the relay answered and refused this address, while
 * `ECONNREFUSED` means nothing was delivered to anybody. Counting them
 * together told every administrator that "email delivery is failing" and that
 * "notifications are not being delivered" because one contact's mailbox was
 * full -- re-raised every fifteen minutes for a day, on an outbox that was
 * otherwise working. Same rule the provider breaker uses: an answer, however
 * bad, proves the host answered.
 */
export interface EmailFailureSnapshot {
  lastFailureAt: Date | null;
  /** Bounded copy of the last transport error's message. */
  lastFailureMessage: string | null;
  lastSuccessAt: Date | null;
  failuresSinceSuccess: number;
  /** Addresses the relay answered about and refused. Never raises the alert. */
  recipientRejections: number;
}

const FAILURE_MESSAGE_MAX_LENGTH = 300;

/**
 * Codes nodemailer reports when the message never reached the relay, plus
 * `EAUTH` -- credentials the server rejected outright, which is a deployment
 * fault that stops every send rather than one address failing.
 */
const TRANSPORT_FAILURE_CODES = new Set([
  "EAUTH",
  "ECONNECTION",
  "ECONNREFUSED",
  "EDNS",
  "ESOCKET",
  "ETIMEDOUT",
  "ETLS",
]);

/**
 * Whether this rejection says the deployment cannot send mail at all, as
 * opposed to this recipient or this message being refused.
 *
 * An SMTP `responseCode` means the relay answered: 4xx/5xx about a message is
 * that message's problem (a full mailbox, a rejected sender, a spam verdict),
 * not an outage -- except for an authentication failure, where the answer is
 * "these credentials are wrong" and nothing will ever be delivered. Anything
 * with no response at all is transport.
 */
export function isSmtpTransportFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSPORT_FAILURE_CODES.has(code)) {
    return true;
  }
  const responseCode = (error as { responseCode?: unknown } | null)
    ?.responseCode;
  return typeof responseCode !== "number";
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private configured = false;
  private lastFailureAt: Date | null = null;
  private lastFailureMessage: string | null = null;
  private lastSuccessAt: Date | null = null;
  private failuresSinceSuccess = 0;
  private recipientRejections = 0;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>("SMTP_HOST");
    const user = this.configService.get<string>("SMTP_USER");
    const password = this.configService.get<string>("SMTP_PASSWORD");

    if (!host || !user || !password) {
      this.logger.warn("SMTP not configured - email features disabled");
      return;
    }

    const port = this.configService.get<number>("SMTP_PORT", 587);
    // Port 465 uses implicit TLS; port 587 uses STARTTLS (secure must be false)
    const secure = port === 465;

    const transportOptions: Record<string, unknown> = {
      host,
      port,
      secure,
      auth: { user, pass: password },
    };

    // For port 587, require STARTTLS upgrade (don't fall back to plaintext)
    if (!secure) {
      transportOptions.requireTLS = true;
    }

    this.transporter = nodemailer.createTransport(transportOptions);

    this.configured = true;
    this.logger.log("SMTP email transport configured");
  }

  getStatus(): { configured: boolean } {
    return { configured: this.configured };
  }

  /** Read by SystemAlertMonitorService's SMTP-health sweep. */
  getFailureSnapshot(): EmailFailureSnapshot {
    return {
      lastFailureAt: this.lastFailureAt,
      lastFailureMessage: this.lastFailureMessage,
      lastSuccessAt: this.lastSuccessAt,
      failuresSinceSuccess: this.failuresSinceSuccess,
      recipientRejections: this.recipientRejections,
    };
  }

  async sendMail(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter || !this.configured) {
      throw new Error("SMTP is not configured");
    }

    const from = this.configService.get<string>(
      "EMAIL_FROM",
      "noreply@monize.app",
    );
    try {
      await this.transporter.sendMail({ from, to, subject, html });
    } catch (error) {
      // Record for the SMTP-health sweep, then rethrow unchanged -- callers
      // already own their per-recipient isolation and their own logging.
      if (isSmtpTransportFailure(error)) {
        this.lastFailureAt = new Date();
        this.lastFailureMessage = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, FAILURE_MESSAGE_MAX_LENGTH);
        this.failuresSinceSuccess += 1;
      } else {
        // The relay answered and refused this address or message. Counted so
        // the state is visible, never as evidence that delivery is broken.
        this.recipientRejections += 1;
      }
      throw error;
    }
    this.lastSuccessAt = new Date();
    this.failuresSinceSuccess = 0;
    this.logger.log(`Email sent to ${to}: ${subject}`);
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}
