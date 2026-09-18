import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";

import { User } from "../users/entities/user.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { hashToken } from "./crypto.util";
import { PasswordBreachService } from "./password-breach.service";
import { tr } from "../i18n/translate";
import { TokenService } from "./token.service";
import { AuthAttemptCounterService } from "./auth-attempt-counter.service";

/**
 * `auth_attempt_counters.scope` for the two per-email throttles.
 *
 * The key is `sha256(lowercased, trimmed email)`. The table has no owner column
 * and is RLS-exempt, so a plaintext key would make it a directory of who has
 * asked for a password reset -- which is precisely the enumeration these two
 * endpoints answer generically to avoid.
 */
export const FORGOT_PASSWORD_SCOPE = "forgot-password";
export const VERIFICATION_EMAIL_SCOPE = "verification-email";

@Injectable()
export class AuthEmailService {
  private readonly logger = new Logger(AuthEmailService.name);

  // M7: Per-email rate limiting for forgot-password
  private readonly FORGOT_PASSWORD_EMAIL_LIMIT = 3;
  private readonly FORGOT_PASSWORD_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  // Per-email rate limiting for resending the verification email. Shares the
  // same window/limit shape as forgot-password to throttle abuse.
  private readonly VERIFICATION_EMAIL_LIMIT = 3;
  private readonly VERIFICATION_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly dataSource: DataSource,
    private passwordBreachService: PasswordBreachService,
    private tokenService: TokenService,
    private readonly attemptCounters: AuthAttemptCounterService,
  ) {}

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had. Multi-statement units use
   * an explicit `withScopedDb` block so their statements share one transaction.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  /**
   * Count this address's use of one throttled endpoint and say whether it may
   * proceed.
   *
   * One statement decides it, so N replicas enforce one limit and a restart no
   * longer hands the sender a fresh three. The window is not extended by a
   * refused attempt: `increment` keeps `window_expires_at` as the first attempt
   * set it, which is the behaviour the `windowStart` field had.
   */
  private async withinEmailLimit(
    scope: string,
    email: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    const { count } = await this.attemptCounters.increment(
      scope,
      hashToken(email.toLowerCase().trim()),
      windowMs,
    );
    return count <= limit;
  }

  async generateResetToken(
    email: string,
  ): Promise<{ user: User; token: string } | null> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({
        where: { email },
      }),
    );

    if (!user || !user.passwordHash) return null;

    const rawResetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // SECURITY: Store hashed token
    user.resetToken = hashToken(rawResetToken);
    user.resetTokenExpiry = resetTokenExpiry;
    await this.scoped(User, (repo) => repo.save(user));

    return { user, token: rawResetToken };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Check for breached password
    const isBreached = await this.passwordBreachService.isBreached(newPassword);
    if (isBreached) {
      throw new BadRequestException(
        tr(
          "errors.auth.passwordBreached",
          "This password has been found in a data breach. Please choose a different password.",
        ),
      );
    }

    // SECURITY: Hash the incoming token to compare against stored hash
    const hashedToken = hashToken(token);

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    // M11: Atomic UPDATE...WHERE to prevent TOCTOU race condition.
    const result = await this.scoped(User, (repo) =>
      repo
        .createQueryBuilder()
        .update(User)
        .set({
          passwordHash,
          resetToken: null,
          resetTokenExpiry: null,
        })
        .where("resetToken = :hashedToken", { hashedToken })
        .andWhere("resetTokenExpiry > :now", { now: new Date() })
        .returning("id")
        .execute(),
    );

    if (!result.affected || result.affected === 0) {
      throw new BadRequestException(
        tr(
          "errors.auth.invalidOrExpiredResetToken",
          "Invalid or expired reset token",
        ),
      );
    }

    // Revoke all refresh tokens to force re-login on all devices
    const userId = result.raw?.[0]?.id;
    if (userId) {
      await this.tokenService.revokeAllUserRefreshTokens(userId);
      // SECURITY: Revoke trusted devices so a stolen trusted-device cookie
      // cannot bypass 2FA after a password reset.
      await this.scoped(TrustedDevice, (repo) => repo.delete({ userId }));
    }
  }

  checkForgotPasswordEmailLimit(email: string): Promise<boolean> {
    return this.withinEmailLimit(
      FORGOT_PASSWORD_SCOPE,
      email,
      this.FORGOT_PASSWORD_EMAIL_LIMIT,
      this.FORGOT_PASSWORD_EMAIL_WINDOW_MS,
    );
  }

  /**
   * Mint a fresh email-verification token for an unverified local account.
   * Returns null (and writes nothing) when no matching unverified account
   * exists, so callers can return a generic success to prevent enumeration.
   * Only the hashed token is stored; the raw value is returned for the link.
   */
  async generateVerificationToken(
    email: string,
  ): Promise<{ user: User; token: string } | null> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.scoped(User, (repo) =>
      repo.findOne({
        where: { email: normalizedEmail },
      }),
    );

    // Nothing to do for unknown emails or accounts that are already verified.
    if (!user || user.emailVerified) return null;

    const rawToken = crypto.randomBytes(32).toString("hex");
    user.emailVerificationToken = hashToken(rawToken);
    user.emailVerificationTokenExpiry = new Date(
      Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    );
    await this.scoped(User, (repo) => repo.save(user));

    return { user, token: rawToken };
  }

  /**
   * Mark the account owning the given verification token as verified. Uses an
   * atomic UPDATE...WHERE (mirroring resetPassword) so a single click wins and
   * the token cannot be replayed once consumed.
   */
  async verifyEmail(token: string): Promise<void> {
    const hashedToken = hashToken(token);

    const result = await this.scoped(User, (repo) =>
      repo
        .createQueryBuilder()
        .update(User)
        .set({
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationTokenExpiry: null,
        })
        .where("emailVerificationToken = :hashedToken", { hashedToken })
        .andWhere("emailVerificationTokenExpiry > :now", { now: new Date() })
        .execute(),
    );

    if (!result.affected || result.affected === 0) {
      throw new BadRequestException(
        tr(
          "errors.auth.invalidOrExpiredEmailVerificationToken",
          "Invalid or expired verification link",
        ),
      );
    }
  }

  checkVerificationEmailLimit(email: string): Promise<boolean> {
    return this.withinEmailLimit(
      VERIFICATION_EMAIL_SCOPE,
      email,
      this.VERIFICATION_EMAIL_LIMIT,
      this.VERIFICATION_EMAIL_WINDOW_MS,
    );
  }
}
