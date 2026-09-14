import { isShardableId, shardedSegments } from "../../common/shard-path.util";
import { BackupOffsiteDestination } from "./entities/backup-offsite-upload.entity";

/**
 * The name one off-machine copy is addressed by, and the way back from it.
 *
 * An append-only destination can add an object and can never overwrite or delete
 * one, so the key has to be **stable for the same bytes and distinct for
 * different bytes** -- that single property is what makes re-running a completed
 * artifact a no-op and a same-day re-export a second recovery point rather than
 * a lost one (`docs/specs/backup-off-machine.md` section 6, INV-BACKUP-004).
 *
 * It lives beside the dispatcher rather than inside it because the retry sweep
 * reads keys the dispatcher wrote, hours later and from a durable row: the two
 * directions are one rule, and a rule with two spellings is a rule that drifts.
 */

/** How much of the egress digest disambiguates the key. */
const DIGEST_SEGMENT_LENGTH = 12;

/**
 * The S3 object key for one artifact, without the destination's own prefix
 * (`BackupOffsiteS3Uploader` joins that): `<ab>/<cd>/<userId>/<name>-<digest12>.<ext>`.
 *
 * The shard layout is the local backup volume's, through the one implementation
 * both use (`common/shard-path.util.ts`). Sharding here is storage
 * distribution, never authorization -- what an object belongs to is the row in
 * `backup_offsite_uploads`, not the path it sits at.
 */
export function offsiteObjectKey(
  userId: string,
  filename: string,
  digest: string,
): string {
  if (!isShardableId(userId)) {
    throw new Error("Cannot build an off-site object key for that user id");
  }
  return [...shardedSegments(userId), keyFileName(filename, digest)].join("/");
}

/**
 * The artifact filename an object key was built from -- the inverse of
 * `offsiteObjectKey`, for the retry sweep, which holds the row and not the run.
 *
 * Deliberately derived rather than stored: a `filename` column would be a second
 * spelling of the key, and the two could disagree. The email destination's key
 * *is* the filename, so there is nothing to undo there. A key this module did
 * not compose is returned unchanged, so the caller's own "no such artifact"
 * handling is what reports it rather than a guess made here.
 */
export function offsiteArtifactFileName(
  destination: BackupOffsiteDestination,
  objectKey: string,
  digest: string,
): string {
  if (destination === "email") return objectKey;
  const last = objectKey.split("/").pop() ?? "";
  const ext = extensionOf(last);
  const stem = last.slice(0, last.length - ext.length);
  const suffix = `-${digest.slice(0, DIGEST_SEGMENT_LENGTH)}`;
  return stem.endsWith(suffix)
    ? `${stem.slice(0, stem.length - suffix.length)}${ext}`
    : last;
}

/** `<stem>-<digest12><ext>`, the key's last segment. */
function keyFileName(filename: string, digest: string): string {
  const ext = extensionOf(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem}-${digest.slice(0, DIGEST_SEGMENT_LENGTH)}${ext}`;
}

/** The two extensions an artifact can carry, as `backup-file-names.ts` writes them. */
function extensionOf(filename: string): string {
  return filename.endsWith(".mzbe") ? ".mzbe" : ".json.gz";
}
