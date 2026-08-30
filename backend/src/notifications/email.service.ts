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
 */
export interface EmailFailureSnapshot {
  lastFailureAt: Date | null;
  /** Bounded copy of the last transport error's message. */
  lastFailureMessage: string | null;
  lastSuccessAt: Date | null;
  failuresSinceSuccess: number;
}

const FAILURE_MESSAGE_MAX_LENGTH = 300;

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private configured = false;
  private lastFailureAt: Date | null = null;
  private lastFailureMessage: string | null = null;
  private lastSuccessAt: Date | null = null;
  private failuresSinceSuccess = 0;

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
      this.lastFailureAt = new Date();
      this.lastFailureMessage = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, FAILURE_MESSAGE_MAX_LENGTH);
      this.failuresSinceSuccess += 1;
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
