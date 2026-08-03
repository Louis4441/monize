import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import * as bcrypt from "bcryptjs";
import { User } from "../users/entities/user.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { tr } from "../i18n/translate";

/**
 * What the automatic backup for a user should be encrypted with. Three answers,
 * not two: "no password stored" and "a password is stored that we cannot use"
 * are different situations and the caller has to treat them differently -- the
 * first is an ordinary unencrypted backup, the second is a misconfigured server
 * that must not quietly start writing plaintext where it used to write
 * ciphertext.
 */
export type BackupPasswordResolution =
  | { status: "none" }
  | { status: "password"; password: string }
  | { status: "unrecoverable" };

/**
 * Owns the stored copy of a user's backup password that the auto-backup cron
 * needs in order to encrypt what it writes.
 *
 * There is nothing for the user to switch on. A backup is encrypted with the
 * password they already have, and the only moment the server ever sees that
 * password in plaintext is when they type it -- so it is captured there
 * (`rememberLoginPassword`, called on registration, login and password change)
 * rather than asked for a second time in Settings.
 *
 * Storage shape: `users.backup_password_enc` holds the password ciphertext
 * encrypted with AI_ENCRYPTION_KEY, and `backup_encryption_enabled` records
 * that a usable copy is there. OIDC accounts have no password of their own, so
 * they have nothing to store and their backups are written unencrypted.
 */
@Injectable()
export class BackupEncryptionService {
  private readonly logger = new Logger(BackupEncryptionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly aiEncryption: AiEncryptionService,
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
   * Whether this user's backups are encrypted. Read-only: the export screen
   * needs it to know whether to ask for the password before downloading.
   */
  async getStatus(userId: string): Promise<{ enabled: boolean }> {
    const user = await this.requireUser(userId);
    return { enabled: user.backupEncryptionEnabled };
  }

  /**
   * Store the local-auth password the user has just proved they know, so the
   * backup cron can encrypt with it. Called from registration, login and the
   * change-password flow -- those are the only points where the plaintext
   * exists, and re-storing it on every login is what keeps the copy current
   * after a reset that went through some other path.
   *
   * Best-effort by design: this is a side benefit of signing in, and a failure
   * here must never stop somebody signing in.
   */
  async rememberLoginPassword(userId: string, password: string): Promise<void> {
    try {
      if (!password || !this.aiEncryption.isConfigured()) return;
      const user = await this.scoped(User, (repo) =>
        repo.findOne({ where: { id: userId } }),
      );
      // OIDC accounts have no password of ours to remember.
      if (!user || user.authProvider !== "local") return;

      // Skip the write when the stored copy already matches, so an ordinary
      // login does not touch the users table.
      if (user.backupEncryptionEnabled && user.backupPasswordEnc) {
        try {
          if (this.aiEncryption.decrypt(user.backupPasswordEnc) === password) {
            return;
          }
        } catch {
          // Undecryptable: fall through and replace it with a fresh copy.
        }
      }

      user.backupPasswordEnc = this.aiEncryption.encrypt(password);
      user.backupEncryptionEnabled = true;
      await this.scoped(User, (repo) => repo.save(user));
    } catch (err) {
      this.logger.error(
        `Failed to store the backup password for user ${userId}: ${err.message}`,
      );
    }
  }

  /**
   * The password this user's automatic backup should be encrypted with.
   *
   * A stored copy is checked against the account's current password hash before
   * it is used. A password changed through a path that could not update the
   * stored copy would otherwise produce a backup encrypted with a password the
   * user no longer knows -- a file that looks like a backup and cannot be
   * opened. A stale copy is dropped here and re-captured at the next login.
   */
  async resolveBackupPassword(user: User): Promise<BackupPasswordResolution> {
    if (!user.backupEncryptionEnabled || !user.backupPasswordEnc) {
      return { status: "none" };
    }

    let password: string;
    try {
      password = this.aiEncryption.decrypt(user.backupPasswordEnc);
    } catch (err) {
      // Typically AI_ENCRYPTION_KEY was rotated. The user's other backups are
      // encrypted, so writing this one in plaintext instead would be a silent
      // downgrade: report it and let the caller refuse.
      this.logger.error(
        `Failed to decrypt stored backup password for user ${user.id}: ${err.message}`,
      );
      return { status: "unrecoverable" };
    }

    if (user.authProvider === "local" && user.passwordHash) {
      const current = await bcrypt.compare(password, user.passwordHash);
      if (!current) {
        this.logger.warn(
          `Stored backup password for user ${user.id} no longer matches their login password; dropping it until their next sign-in`,
        );
        await this.forgetStoredPassword(user.id);
        return { status: "none" };
      }
    }

    return { status: "password", password };
  }

  /** Drop the stored copy, leaving backups unencrypted until it is recaptured. */
  async forgetStoredPassword(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      const user = await repo.findOne({ where: { id: userId } });
      if (!user) return;
      user.backupEncryptionEnabled = false;
      user.backupPasswordEnc = null;
      await repo.save(user);
    });
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new NotFoundException(
        tr("errors.backup.userNotFoundRestore", "User not found"),
      );
    }
    return user;
  }
}
