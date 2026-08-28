import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decrypt, derivePurposeKey, encrypt } from "../auth/crypto.util";

/**
 * HKDF label for the key this feature falls back to. Domain separation is what
 * makes reusing `JWT_SECRET` here safe: the derived key is cryptographically
 * independent of the session-signing key and of every other purpose derived
 * from the same secret (`csrf-token`, `totp-encryption`, `oauth-provider-cookies`).
 */
export const BACKUP_PASSWORD_KEY_PURPOSE = "backup-password-encryption";

/** Shortest secret either source may supply; matches the JWT_SECRET floor. */
const MIN_KEY_LENGTH = 32;

/**
 * Encrypts the copy of a user's password that the auto-backup cron needs, and
 * is the reason automatic encryption no longer depends on optional configuration.
 *
 * It used to be `AiEncryptionService`, keyed on `AI_ENCRYPTION_KEY`. That
 * variable is optional -- commented out in `.env.example`, documented as being
 * for cloud AI providers, and passed as `${AI_ENCRYPTION_KEY:-}` by the compose
 * files -- so on an install that never configured an AI provider the capture at
 * sign-in returned early and every automatic backup was written in plaintext,
 * with no log line, no status field and nothing in Settings to see (issue #1269).
 * A feature whose whole design is "on by default, nothing to switch on" cannot
 * hang off a variable most deployments do not set.
 *
 * So the key is derived from `JWT_SECRET`, which is mandatory and enforced at
 * startup to be at least 32 characters (`jwt.strategy.ts`) -- the same source and
 * the same `derivePurposeKey` that already encrypts TOTP secrets at rest.
 *
 * `AI_ENCRYPTION_KEY` stays the *preferred* key wherever it is configured, so an
 * install that already has one keeps writing and reading exactly the ciphertext
 * it has today, and an operator who deliberately separated that key keeps that
 * separation. Both keys are accepted on the way in, which is what lets a
 * deployment add or remove the AI key without stranding the copies already
 * stored under the other one.
 */
@Injectable()
export class BackupPasswordCipher {
  /**
   * Decryption candidates, preferred first. `encrypt` writes under `keys[0]`.
   * Empty only when neither source supplies a usable secret, which startup
   * already refuses for `JWT_SECRET` -- so in a booted server this holds at
   * least one key.
   */
  private readonly keys: readonly string[];

  constructor(configService: ConfigService) {
    const aiKey = configService.get<string>("AI_ENCRYPTION_KEY", "") ?? "";
    const jwtSecret = configService.get<string>("JWT_SECRET", "") ?? "";

    const candidates = [
      aiKey.length >= MIN_KEY_LENGTH ? aiKey : null,
      jwtSecret.length >= MIN_KEY_LENGTH
        ? derivePurposeKey(jwtSecret, BACKUP_PASSWORD_KEY_PURPOSE)
        : null,
    ];
    this.keys = candidates.filter((key): key is string => key !== null);
  }

  /** Whether this server can store a backup password at all. */
  isConfigured(): boolean {
    return this.keys.length > 0;
  }

  encrypt(plaintext: string): string {
    if (!this.isConfigured()) {
      throw new Error(
        "No key is available to encrypt the stored backup password (JWT_SECRET must be at least 32 characters)",
      );
    }
    return encrypt(plaintext, this.keys[0]);
  }

  /**
   * Decrypt under whichever configured key wrote it.
   *
   * Every candidate is tried before failing, because which key wrote a given row
   * depends on what was configured at the time. AES-GCM authenticates, so a wrong
   * key raises rather than returning plausible bytes -- that is what makes trying
   * more than one key sound rather than a guess. Throws the last failure when
   * none of them opens it, matching what a single-key decrypt did.
   */
  decrypt(ciphertext: string): string {
    if (!this.isConfigured()) {
      throw new Error(
        "No key is available to decrypt the stored backup password (JWT_SECRET must be at least 32 characters)",
      );
    }
    let lastError: unknown;
    for (const key of this.keys) {
      try {
        return decrypt(ciphertext, key);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
}
