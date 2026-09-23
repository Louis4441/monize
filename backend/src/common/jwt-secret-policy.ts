/**
 * The one rule for whether a `JWT_SECRET` may sign anything.
 *
 * `JWT_SECRET` signs every session token and is the root every purpose key is
 * derived from (CSRF, TOTP encryption, the OAuth cookie keys, restore tickets),
 * so a value an attacker can guess is a forged session for every account. A
 * length floor alone admits the placeholder shipped in `.env.example`, which a
 * deployment that followed "cp .env.example .env" and never edited the line
 * would boot with.
 *
 * Both checks that read the secret call this -- `checkClusterBoot`, which turns
 * a refusal into a first-line log message, and `JwtStrategy`, which refuses the
 * same value further in -- so the two cannot disagree: a secret one of them
 * admits and the other refuses would boot on one path and die on the other.
 *
 * The rule is deliberately conservative. Every value "openssl rand -base64 32"
 * or "openssl rand -hex 32" can produce passes it (see the spec for the
 * arithmetic); what it refuses is a known placeholder, anything built around a
 * placeholder phrase, and a value whose character set or repetition shows it
 * was typed rather than generated.
 */

import { timingSafeEqual } from "crypto";

/** Shortest `JWT_SECRET` the server will start with. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Fewest distinct characters a secret may be built from. A 64-character hex
 * string draws from 16 symbols and holds fewer than 8 of them with probability
 * about 1e-19; `"x".repeat(32)` or `"abab..."` holds one or two.
 */
export const MIN_JWT_SECRET_DISTINCT_CHARS = 8;

/**
 * Placeholder values published in this repository's example configuration and
 * documentation, compared after trimming, unquoting and lower-casing. A value
 * a reader can copy from the README or `.env.example` is public.
 */
export const KNOWN_PLACEHOLDER_JWT_SECRETS: readonly string[] = [
  "your-super-secret-jwt-key-change-in-production",
  "your-secret-key",
];

/**
 * Phrases no generated secret contains and every "fill me in" value does. A
 * base64 or hex secret contains none of them (a hyphen is outside both
 * alphabets), so refusing a secret that contains one refuses only a value a
 * person typed as a reminder to change it.
 */
const PLACEHOLDER_PHRASES: readonly string[] = [
  "change-in-production",
  "change-me",
  "changeme",
  "change_me",
  "replace-me",
  "replaceme",
  "your-super-secret",
  "your-secret",
];

function normalize(secret: string): string {
  return secret
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .toLowerCase();
}

/** True when the whole secret is one shorter unit repeated. */
function isRepeatedUnit(secret: string): boolean {
  for (let unit = 1; unit <= secret.length / 2; unit++) {
    if (secret.length % unit !== 0) continue;
    const head = secret.slice(0, unit);
    // Compared in constant time because the right-hand side is the signing
    // secret itself (CWE-208). Byte lengths can differ for multi-byte input,
    // which timingSafeEqual refuses, and which also means "not a repeat".
    const candidate = Buffer.from(head.repeat(secret.length / unit));
    const actual = Buffer.from(secret);
    if (
      candidate.length === actual.length &&
      timingSafeEqual(candidate, actual)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Why this value may not be used as `JWT_SECRET`, or `null` when it may.
 *
 * Length is measured on the value as given, untrimmed, so an existing
 * deployment whose secret carries surrounding whitespace is judged the same way
 * by both callers. The returned sentence is a boot log line, read by an
 * operator, not a message for an end user.
 */
export function jwtSecretProblem(
  secret: string | undefined | null,
): string | null {
  const value = secret ?? "";
  if (value.length === 0) {
    return "JWT_SECRET is not set.";
  }
  if (value.length < MIN_JWT_SECRET_LENGTH) {
    return `JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters.`;
  }
  const normalized = normalize(value);
  if (
    KNOWN_PLACEHOLDER_JWT_SECRETS.includes(normalized) ||
    PLACEHOLDER_PHRASES.some((phrase) => normalized.includes(phrase))
  ) {
    return (
      "JWT_SECRET is still the example placeholder. It is published in this " +
      "repository, so anyone can sign a session token with it."
    );
  }
  if (
    new Set(value).size < MIN_JWT_SECRET_DISTINCT_CHARS ||
    isRepeatedUnit(value)
  ) {
    return (
      "JWT_SECRET is too predictable: it is built from too few distinct " +
      "characters or repeats one short pattern."
    );
  }
  return null;
}
