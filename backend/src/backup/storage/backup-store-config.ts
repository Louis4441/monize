import { clampS3Deadline } from "../../attachments/storage/s3-transport";
import { OffsiteS3Target } from "../offsite/backup-offsite.types";

/**
 * Where a deployment keeps its primary automatic backups, read from the
 * environment.
 *
 * Pure over a `(name) => string | undefined` getter rather than reading
 * `process.env` or holding a `ConfigService`, for the reason
 * `backup-offsite-config.ts` gives about its own half: the decisions here --
 * which target is selected, what a missing bucket means, whether the store and
 * the off-machine destination are the same place -- are the ones worth testing,
 * and a module that reaches for the ambient environment can only be tested by
 * mutating it.
 */

/** How a caller supplies configuration. Returns `undefined` when unset. */
export type BackupStoreEnvGetter = (name: string) => string | undefined;

/** The targets `BACKUP_STORAGE_PROVIDER` may name. */
export const BACKUP_STORE_PROVIDERS = ["local", "s3"] as const;
export type BackupStoreProvider = (typeof BACKUP_STORE_PROVIDERS)[number];

/** Where an `s3` store puts its objects, and how it reaches them. */
export interface BackupStoreS3Config {
  readonly bucket: string;
  /** Normalised to at most one trailing slash, or `undefined` for the root. */
  readonly prefix?: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Already clamped by `clampS3Deadline`; see `s3-transport.ts`. */
  readonly deadlineMs: number;
}

const text = (get: BackupStoreEnvGetter, name: string): string | undefined => {
  const value = get(name)?.trim();
  return value ? value : undefined;
};

/**
 * Which target this deployment stores its automatic backups on.
 *
 * `local` unless something says otherwise, in every cluster mode including
 * `multi` -- where a `local` store refuses without the shared-volume assertion,
 * which is a refusal an operator can answer two ways, and choosing for them is
 * how a default becomes a surprise (`docs/specs/backup-storage-targets.md`
 * section 11, decision 3).
 *
 * An unrecognised value is a refusal rather than a silent fall back to `local`:
 * a typo in this variable would otherwise put a deployment's recovery points on
 * a pod's disk while its operator believed they were in a bucket, and a backup
 * that is somewhere other than where you think it is has already failed.
 */
export function resolveBackupStoreProvider(
  get: BackupStoreEnvGetter,
): BackupStoreProvider {
  const configured = text(get, "BACKUP_STORAGE_PROVIDER")?.toLowerCase();
  if (!configured) return "local";
  const known = BACKUP_STORE_PROVIDERS.find((name) => name === configured);
  if (!known) {
    throw new Error(
      `BACKUP_STORAGE_PROVIDER=${configured} is not a backup storage target. ` +
        `Use one of: ${BACKUP_STORE_PROVIDERS.join(", ")}.`,
    );
  }
  return known;
}

/**
 * A key prefix, normalised to at most one trailing slash -- the same shape
 * `S3StorageProvider` gives `ATTACHMENT_S3_PREFIX` and
 * `normalizeOffsitePrefix` gives the off-machine destination's, so an operator
 * who has configured one bucket has configured all three the same way.
 */
export function normalizeStorePrefix(
  prefix: string | null | undefined,
): string | undefined {
  if (!prefix) return undefined;
  const trimmed = prefix.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : undefined;
}

/**
 * The `s3` store's configuration.
 *
 * The variables are `BACKUP_STORE_S3_*`, **not** `BACKUP_S3_*`, and the
 * difference is INV-BACKUP-007 rather than a naming preference: `BACKUP_S3_*` is
 * already the off-machine destination's deployment default, so a store reusing
 * that prefix would put the primary artifact and its off-machine copy in one
 * bucket, by default and silently -- the exact failure the off-machine feature
 * was built to prevent, arriving as a configuration convenience.
 *
 * Credentials are passed only when **both** halves are present. Half a key pair
 * is not a credential, and signing with one fails in a way that reads like a
 * permissions problem; omitting them entirely is the documented state -- the
 * default AWS credential chain, which is how a deployment on EC2 or EKS reaches
 * its own bucket.
 */
export function resolveBackupStoreS3Config(
  get: BackupStoreEnvGetter,
): BackupStoreS3Config {
  const bucket = text(get, "BACKUP_STORE_S3_BUCKET");
  if (!bucket) {
    throw new Error(
      "BACKUP_STORE_S3_BUCKET must be set when BACKUP_STORAGE_PROVIDER=s3",
    );
  }
  const accessKeyId = text(get, "BACKUP_STORE_S3_ACCESS_KEY_ID");
  const secretAccessKey = text(get, "BACKUP_STORE_S3_SECRET_ACCESS_KEY");
  const credentials =
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey }
      : undefined;

  return {
    bucket,
    ...(normalizeStorePrefix(text(get, "BACKUP_STORE_S3_PREFIX"))
      ? { prefix: normalizeStorePrefix(text(get, "BACKUP_STORE_S3_PREFIX")) }
      : {}),
    ...(text(get, "BACKUP_STORE_S3_REGION")
      ? { region: text(get, "BACKUP_STORE_S3_REGION") }
      : {}),
    ...(text(get, "BACKUP_STORE_S3_ENDPOINT")
      ? { endpoint: text(get, "BACKUP_STORE_S3_ENDPOINT") }
      : {}),
    // A boolean environment variable is compared as the string it is: the typed
    // `get<boolean>` reads as a conversion and is only an assertion.
    forcePathStyle: get("BACKUP_STORE_S3_FORCE_PATH_STYLE")?.trim() === "true",
    ...(credentials ? { credentials } : {}),
    // Shorten-only, and clamped by the same helper every S3 caller uses, so no
    // deployment can widen the window in which a put may still land.
    deadlineMs: clampS3Deadline(get("BACKUP_STORE_S3_REQUEST_TIMEOUT_MS")),
  };
}

/**
 * One S3 location, for comparing a store against an off-machine destination.
 *
 * `endpoint` is part of the identity because the same bucket name on two
 * services is two places, and its absence (AWS) is a value of its own.
 */
export interface S3Location {
  readonly endpoint?: string;
  readonly bucket: string;
  readonly prefix?: string;
}

/**
 * Whether a store and an off-machine destination would write to the same place
 * (INV-BACKUP-007).
 *
 * "The same place" is broader than string equality on purpose. Two prefixes
 * where one contains the other are one place: `backups/` and `backups/store/`
 * are not separate failure domains, and the off-machine copy exists to survive
 * the loss of the store. A trailing-slash difference is not a difference at all,
 * which is why both sides are normalised before they are compared.
 *
 * An endpoint or bucket that differs makes them two places whatever the prefixes
 * say; comparing prefixes across buckets would refuse a perfectly good
 * configuration.
 */
export function sharesLocation(
  store: S3Location,
  offsite: S3Location,
): boolean {
  const sameEndpoint =
    (store.endpoint ?? "").replace(/\/+$/, "") ===
    (offsite.endpoint ?? "").replace(/\/+$/, "");
  if (!sameEndpoint || store.bucket !== offsite.bucket) return false;

  const a = normalizeStorePrefix(store.prefix) ?? "";
  const b = normalizeStorePrefix(offsite.prefix) ?? "";
  // Both carry one trailing slash (or are empty, meaning the bucket root), so a
  // containment test is a prefix test and cannot match a sibling whose name
  // merely begins the same way: `backups/` never matches `backups-old/`.
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Refuse a deployment whose store and deployment-default off-machine
 * destination are one place.
 *
 * Not a warning. The off-machine copy exists to survive the loss of the store,
 * and one bucket holding both is a 3-2-1 arrangement that is actually a 1. A
 * deployment that has not configured an off-machine destination has nothing to
 * collide with, so `offsite` is `null` and this passes.
 */
export function assertStoreAndOffsiteDiffer(
  store: BackupStoreS3Config,
  offsite: Pick<OffsiteS3Target, "bucket" | "prefix" | "endpoint"> | null,
): void {
  if (!offsite) return;
  if (!sharesLocation(store, offsite)) return;
  throw new Error(
    "The automatic backup store and the off-machine backup destination are " +
      `the same location (bucket "${store.bucket}"` +
      (store.endpoint ? ` at ${store.endpoint}` : "") +
      `, prefixes "${store.prefix ?? ""}" and "${offsite.prefix ?? ""}"). ` +
      "The off-machine copy exists to survive the loss of the store, so one " +
      "bucket holding both is not a second copy (INV-BACKUP-007). Point " +
      "BACKUP_STORE_S3_* and BACKUP_S3_* at different buckets, or at " +
      "non-overlapping prefixes in different buckets.",
  );
}
