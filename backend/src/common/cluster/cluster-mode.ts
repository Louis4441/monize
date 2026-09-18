/**
 * Cluster runtime mode: how many replicas of this process are expected to serve
 * one database.
 *
 *   - `single` : the default, and today's behaviour byte-for-byte. One replica.
 *                In-process state (throttler counters, the AI relay's live
 *                promises) is correct because there is only one process.
 *   - `multi`  : several replicas behind a load balancer with no session
 *                affinity. Anything a second replica would get wrong must be a
 *                row, so the mode is a precondition the boot checks rather
 *                than a hint. PostgreSQL is the only shared store: the
 *                throttler's counters are a table and the cross-replica
 *                wake-up is `LISTEN`/`NOTIFY`, so `multi` adds no dependency
 *                and no connection setting of its own.
 *
 * The parse-and-throw shape is `parseRlsMode` in `backend/src/common/db/rls-config.ts`: an
 * unrecognized value refuses the boot instead of silently falling back to a
 * mode the operator did not ask for.
 *
 * See `docs/future-plans/horizontal-scaling.md` for the work this gates.
 */
export const CLUSTER_MODES = ["single", "multi"] as const;

export type ClusterMode = (typeof CLUSTER_MODES)[number];

/** What an unset or blank `CLUSTER_MODE` means. */
export const DEFAULT_CLUSTER_MODE: ClusterMode = "single";

/**
 * DI token for the parsed mode.
 *
 * Here rather than in `cluster.module.ts` for the reason
 * `ATTACHMENT_STORAGE_PROVIDER` sits in its interface file: a consumer that
 * needs the token should not have to import a module file to get it, which is
 * how a require cycle starts (`module-graph.spec.ts`). `getClusterMode()` stays
 * the answer for code with no injector.
 */
export const CLUSTER_MODE = Symbol("CLUSTER_MODE");

/** Shortest `JWT_SECRET` the server will start with (`JwtStrategy` agrees). */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Parse and validate a raw `CLUSTER_MODE` value. Unset or blank is `single`;
 * anything else unrecognized throws.
 */
export function parseClusterMode(raw: string | undefined | null): ClusterMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") {
    return DEFAULT_CLUSTER_MODE;
  }
  if ((CLUSTER_MODES as readonly string[]).includes(value)) {
    return value as ClusterMode;
  }
  throw new Error(
    `Invalid CLUSTER_MODE "${raw}". Must be one of: ${CLUSTER_MODES.join(", ")} ` +
      "(unset defaults to single).",
  );
}

/**
 * Resolve the mode from the environment. Read fresh from `process.env` for the
 * same reason `getRlsMode` does: the answer is needed in places that have no
 * injector.
 */
export function getClusterMode(): ClusterMode {
  return parseClusterMode(process.env.CLUSTER_MODE);
}

/**
 * An operator's assertion that a container directory is one every replica
 * mounts. Compared as the string it is, per the numeric/boolean env rule.
 */
const SHARED_VOLUME_ASSERTED = "true";

/** The subset of the environment the boot matrix reads. */
export interface ClusterBootEnv {
  CLUSTER_MODE?: string;
  JWT_SECRET?: string;
  /** `database` (default), `local` or `s3`; see `attachments.module.ts`. */
  ATTACHMENT_STORAGE_PROVIDER?: string;
  /** Where the `local` provider writes. Named in the refusal, never parsed. */
  ATTACHMENT_CONTAINER_DIR?: string;
  /** The deprecated alias for the above; both name the same directory. */
  ATTACHMENT_LOCAL_DIR?: string;
  /** `true` asserts `ATTACHMENT_CONTAINER_DIR` is mounted by every replica. */
  ATTACHMENT_SHARED_VOLUME?: string;
  /** Where automatic backups are written. Named in the refusal, never parsed. */
  BACKUP_CONTAINER_DIR?: string;
  /** `true` asserts `BACKUP_CONTAINER_DIR` is mounted by every replica. */
  BACKUP_SHARED_VOLUME?: string;
}

export interface ClusterBootReport {
  /** `null` when `CLUSTER_MODE` itself did not parse -- there is no mode to report. */
  mode: ClusterMode | null;
  /** Each reason the process must not serve traffic. Non-empty means exit. */
  refusals: readonly string[];
  /** Each thing an operator should know but that does not stop the boot. */
  warnings: readonly string[];
}

/**
 * The boot matrix, as a pure function of the environment.
 *
 * Pure so the whole table is a unit test rather than a set of container starts,
 * and so `main.ts` holds only the logging and the `process.exit`. It reports
 * every problem it finds instead of the first, because an operator restarting a
 * crash-looping container should need one restart, not one per missing
 * variable.
 *
 * What it deliberately does not cover: anything that needs a connection. In
 * `multi`, that the database host can actually hold the `LISTEN` each replica
 * keeps -- a transaction-mode pooler cannot -- is checked in `main.ts` once the
 * listener is built, because it takes a round trip.
 *
 * The storage checks below are the other half of what `multi` needs, and they
 * are assertions rather than measurements: no process can see from the inside
 * whether the directory under its mount point is the same directory another pod
 * sees. So the operator states it, and the refusal exists to make sure they
 * state it knowingly rather than discover it from a restore that cannot find
 * its bytes.
 */
export function checkClusterBoot(env: ClusterBootEnv): ClusterBootReport {
  const refusals: string[] = [];
  const warnings: string[] = [];

  let mode: ClusterMode | null = null;
  try {
    mode = parseClusterMode(env.CLUSTER_MODE);
  } catch (error) {
    refusals.push(error instanceof Error ? error.message : String(error));
  }

  // Fatal in every mode, single included. Without it `csrf.util.ts` falls back
  // to a per-process random key and `csrf.guard.ts` skips verification
  // entirely, which is a deployment that looks like it has CSRF protection and
  // has none -- and which would fail open differently on every replica. The
  // length floor is the one `JwtStrategy` already enforces; checking it here
  // too turns a dependency-injection stack trace into a first-line log message.
  // Measured untrimmed, exactly as `JwtStrategy` measures it, so this check can
  // only ever refuse a deployment that was already refused further in -- a
  // secret whose length depends on its surrounding whitespace must not boot on
  // one check and die on the other.
  const jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    refusals.push(
      `JWT_SECRET is ${jwtSecret.length === 0 ? "not set" : "shorter than " + MIN_JWT_SECRET_LENGTH + " characters"}. ` +
        "It signs every session token and derives the CSRF and OAuth cookie " +
        "keys, so a server without it cannot protect a request. Generate one " +
        'with "openssl rand -base64 32" and set JWT_SECRET.',
    );
  }

  if (mode === "multi") {
    // Attachments. `local` writes one file per attachment to a container path;
    // on a second pod that path is a different disk, so an upload served by one
    // replica 404s from the other. The chart mounts a ReadWriteOnce claim,
    // which a second pod on another node cannot even attach.
    const provider = (env.ATTACHMENT_STORAGE_PROVIDER ?? "database")
      .trim()
      .toLowerCase();
    const attachmentDir =
      env.ATTACHMENT_CONTAINER_DIR?.trim() ||
      env.ATTACHMENT_LOCAL_DIR?.trim() ||
      "/data/attachments";
    if (
      provider === "local" &&
      env.ATTACHMENT_SHARED_VOLUME?.trim() !== SHARED_VOLUME_ASSERTED
    ) {
      refusals.push(
        `ATTACHMENT_STORAGE_PROVIDER=local writes attachment bytes to ` +
          `${attachmentDir}, which a second replica cannot read unless every ` +
          "replica mounts that same directory (ReadWriteMany or equivalent). " +
          "Set ATTACHMENT_SHARED_VOLUME=true to assert that it does, or use " +
          "ATTACHMENT_STORAGE_PROVIDER=database (cluster-safe by " +
          "construction) or =s3.",
      );
    }
    if (provider === "database") {
      warnings.push(
        "CLUSTER_MODE=multi with ATTACHMENT_STORAGE_PROVIDER=database is " +
          "cluster-safe, and every replica reads the same bytes. Note that it " +
          "puts attachment blobs on the primary, which is a scaling concern of " +
          "a different kind: the s3 provider keeps them off it.",
      );
    }

    // Backups. Unlike attachments there is no provider to choose yet -- the
    // automatic backup always writes to the filesystem -- and whether any user
    // has switched theirs on is a row, not an environment variable, so the
    // check cannot be conditional on it. The refusal is therefore
    // unconditional in `multi` until the S3 backup target ships (plan task S2).
    const backupDir = env.BACKUP_CONTAINER_DIR?.trim() || "/data/backups";
    if (env.BACKUP_SHARED_VOLUME?.trim() !== SHARED_VOLUME_ASSERTED) {
      refusals.push(
        `CLUSTER_MODE=multi writes automatic backups to ${backupDir} on ` +
          "whichever replica runs the hourly job, and a restore served by " +
          "another replica cannot find them. Automatic backups are enabled " +
          "per user, so no setting here says whether any exist. Mount that " +
          "directory on every replica (ReadWriteMany, or a single-host volume " +
          "under docker compose, where it is shared by definition) and set " +
          "BACKUP_SHARED_VOLUME=true.",
      );
    }
  }

  return { mode, refusals, warnings };
}
