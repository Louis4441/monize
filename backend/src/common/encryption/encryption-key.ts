import { Logger } from "@nestjs/common";

/** The variable this deployment is expected to set. */
export const ENCRYPTION_KEY_ENV = "ENCRYPTION_KEY";

/**
 * The name it used to have. Still read, and still the winner where both are
 * set, because the two name the same secret and an existing deployment must not
 * have to re-key anything to take an upgrade -- every column encrypted under it
 * (AI provider API keys, emergency-access grant credentials, the stored backup
 * password) is AES-GCM ciphertext that only that key opens.
 */
export const LEGACY_ENCRYPTION_KEY_ENV = "AI_ENCRYPTION_KEY";

/** Shortest secret either name may supply. */
export const MIN_ENCRYPTION_KEY_LENGTH = 32;

export interface ResolvedEncryptionKey {
  key: string;
  /** Which variable supplied it, so the deprecation can be named exactly once. */
  source: typeof ENCRYPTION_KEY_ENV | typeof LEGACY_ENCRYPTION_KEY_ENV;
}

/** Anything that can answer "what is this variable set to" -- `ConfigService`,
 *  `process.env`, or a test's plain object. */
export type EnvReader = (name: string) => string | undefined;

export function envReaderFromRecord(
  env: Record<string, string | undefined>,
): EnvReader {
  return (name) => env[name];
}

/**
 * The one place the encryption key is read.
 *
 * Two names, one secret, and a deliberate preference for the legacy one: a
 * deployment that sets both has ciphertext written under `AI_ENCRYPTION_KEY`,
 * and reading the new name first would open none of it. New deployments set
 * only `ENCRYPTION_KEY` and never meet the question.
 *
 * A value shorter than the floor is not a key. It is returned as absent rather
 * than used, so "misconfigured" and "unset" reach the startup check as the same
 * refusal instead of one of them booting a server that cannot decrypt anything
 * it writes.
 */
export function resolveEncryptionKey(
  read: EnvReader,
): ResolvedEncryptionKey | null {
  const legacy = read(LEGACY_ENCRYPTION_KEY_ENV) ?? "";
  if (legacy.length >= MIN_ENCRYPTION_KEY_LENGTH) {
    return { key: legacy, source: LEGACY_ENCRYPTION_KEY_ENV };
  }
  const current = read(ENCRYPTION_KEY_ENV) ?? "";
  if (current.length >= MIN_ENCRYPTION_KEY_LENGTH) {
    return { key: current, source: ENCRYPTION_KEY_ENV };
  }
  return null;
}

/**
 * The message an operator gets when neither name supplies a usable key.
 *
 * Exported so the startup refusal and the test that pins it read the same
 * string: an operator meeting this has to learn the variable's name, its floor,
 * and how to produce one, in the first ten lines of a crash-looping container's
 * log.
 */
export function missingEncryptionKeyMessage(): string {
  return (
    `${ENCRYPTION_KEY_ENV} is required and must be at least ` +
    `${MIN_ENCRYPTION_KEY_LENGTH} characters. It encrypts AI provider API keys, ` +
    "emergency-access credentials and the password your backups are encrypted " +
    `with, so a server without it stores none of them. Generate one with ` +
    `"openssl rand -hex 32" and set ${ENCRYPTION_KEY_ENV} in your environment. ` +
    `(Deployments that already set ${LEGACY_ENCRYPTION_KEY_ENV}, the former name ` +
    "for this variable, keep working unchanged.)"
  );
}

/**
 * Refuse to start without a key.
 *
 * Mandatory, not best-effort, and that is the change: while it was optional,
 * `AI_ENCRYPTION_KEY` was documented as being for cloud AI providers, so a
 * deployment that configured none set nothing -- and every automatic backup was
 * written in plaintext because the password capture had nowhere to store its
 * copy, with no log line and nothing on the Settings page (issue #1269). A
 * feature that is on by default cannot depend on configuration a deployment is
 * told it does not need.
 */
export function assertEncryptionKeyConfigured(read: EnvReader): void {
  if (!resolveEncryptionKey(read)) {
    throw new Error(missingEncryptionKeyMessage());
  }
}

/**
 * One line, at startup, naming the variable that supplied the key.
 *
 * A rename nobody is told about is a rename that never happens: the legacy name
 * keeps working forever if the only place it is mentioned is a changelog.
 */
export function logEncryptionKeySource(
  resolved: ResolvedEncryptionKey,
  logger: Logger,
): void {
  if (resolved.source === LEGACY_ENCRYPTION_KEY_ENV) {
    logger.warn(
      `${LEGACY_ENCRYPTION_KEY_ENV} is deprecated and has been renamed to ` +
        `${ENCRYPTION_KEY_ENV} (it encrypts more than AI provider keys). It is ` +
        "still read and still takes precedence, so nothing has to change today; " +
        `to move over, set ${ENCRYPTION_KEY_ENV} to the same value and remove ` +
        `${LEGACY_ENCRYPTION_KEY_ENV} -- changing the value re-keys nothing and ` +
        "makes every stored secret unreadable.",
    );
  }
}
