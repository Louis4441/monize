import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import { AutoBackupService } from "../auto-backup.service";
import {
  BackupOffsiteDispatchService,
  MAX_OFFSITE_ATTEMPTS,
} from "./backup-offsite-dispatch.service";
import { offsiteArtifactFileName } from "./backup-offsite-keys";
import {
  BackupOffsiteDestination,
  BackupOffsiteTier,
} from "./entities/backup-offsite-upload.entity";

/**
 * How many rows one sweep re-attempts.
 *
 * A bound rather than "everything that is due": a destination that has been
 * unreachable for a day leaves one row per user per artifact, and an unbounded
 * sweep would hold the hour open uploading backups while the next one fires. The
 * oldest are taken first, so nothing starves -- the remainder is next hour's.
 */
const SWEEP_LIMIT = 200;

/** One `failed` row the sweep has decided is due. */
interface DueUpload {
  id: string;
  userId: string;
  destination: BackupOffsiteDestination;
  objectKey: string;
  tier: BackupOffsiteTier;
  digest: string;
  sizeBytes: number;
}

/**
 * Re-attempts off-machine copies that failed, under the same claim and the same
 * key (WP6 of `docs/future-plans/backup-off-machine.md`; INV-BACKUP-005's retry
 * half).
 *
 * **Why a reaper at all.** A transient S3 outage or a refused SMTP connection
 * leaves the artifact on the local volume and the copy undone. Without this, the
 * next recovery point off-machine would be tomorrow's -- and the row saying so
 * would sit in a table nobody reads. The durable `failed` state plus this sweep
 * is what makes "it will be retried" a mechanism rather than a hope.
 *
 * **What stops a second replica repeating the effect.** Every replica fires this
 * cron. The sweep itself is only a selection; the arbiter is the same
 * conditional claim the first dispatch takes -- `status IN ('pending','failed')
 * -> 'uploading' ... RETURNING` -- so of two replicas that both selected a row,
 * exactly one gets it back and the other does nothing. Nothing is claimed here
 * that `BackupOffsiteDispatchService` does not claim identically, because the
 * claim and the perform are one implementation shared by both entry points.
 *
 * **Backoff and a floor under it.** A row is due after `1h << (attempts - 1)` --
 * one hour, then two, four, eight -- and is dropped after
 * `MAX_OFFSITE_ATTEMPTS`. A destination that is misconfigured rather than
 * flapping therefore stops being called, and the administrators are told once by
 * the final attempt's alert instead of hourly forever.
 *
 * **One user's failure is one user's failure.** Each row runs inside its own
 * `try`, the shape `handleAutoBackupCron` already holds: a sweep that ended at
 * the first bad row would leave every later user's copy undone with nothing
 * recorded.
 */
@Injectable()
export class BackupOffsiteRetryService {
  private readonly logger = new Logger(BackupOffsiteRetryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: BackupOffsiteDispatchService,
    // For the folder the artifact is read back from: the same resolver the
    // owner-facing listing uses, so the containment checks are not spelled a
    // second way here.
    private readonly autoBackup: AutoBackupService,
  ) {}

  /**
   * Hourly at :30, deliberately away from the backup sweep's :00 -- a retry that
   * fired while every user's export was running would contend with it for the
   * same disk and the same pool.
   */
  @Cron("30 * * * *")
  async handleRetrySweep(): Promise<void> {
    let due: DueUpload[];
    try {
      due = await this.selectDue();
    } catch (error) {
      this.logger.error(
        `Off-site retry sweep could not select due copies: ${messageOf(error)}`,
      );
      return;
    }
    if (due.length === 0) return;

    this.logger.log(`Off-site retry sweep: ${due.length} copy(s) due`);
    for (const row of due) {
      try {
        await withUserContext(row.userId, () => this.retryOne(row));
      } catch (error) {
        this.logger.error(
          `Off-site retry failed for user ${row.userId}, ` +
            `${row.destination}:${row.objectKey}: ${messageOf(error)}`,
        );
      }
    }
  }

  /**
   * The `failed` rows whose backoff has elapsed, oldest first.
   *
   * Cross-user by construction -- it enumerates every user's outstanding copies
   * from a cron with no request behind it -- so it runs under the system context
   * and every per-row body below re-seeds its owner's.
   *
   * The backoff is computed in SQL rather than in a predicate here: the sweep
   * would otherwise have to read every failed row in the deployment to decide
   * which of them are due.
   */
  private async selectDue(): Promise<DueUpload[]> {
    const rows = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `SELECT id,
                  user_id,
                  destination,
                  object_key,
                  tier,
                  digest,
                  size_bytes
             FROM backup_offsite_uploads
            WHERE status = 'failed'
              AND attempts < $1
              AND updated_at <=
                  now() - (INTERVAL '1 hour' * power(2, GREATEST(attempts - 1, 0)))
            ORDER BY updated_at ASC
            LIMIT $2`,
          [MAX_OFFSITE_ATTEMPTS, SWEEP_LIMIT],
        ),
      ),
    );
    return returnedRows<{
      id: string;
      user_id: string;
      destination: BackupOffsiteDestination;
      object_key: string;
      tier: BackupOffsiteTier;
      digest: string;
      size_bytes: string | number;
    }>(rows).map((row) => ({
      id: row.id,
      userId: row.user_id,
      destination: row.destination,
      objectKey: row.object_key,
      tier: row.tier,
      digest: row.digest,
      // BIGINT arrives from the driver as a string; the email bound and the
      // length check downstream are numeric comparisons.
      sizeBytes: Number(row.size_bytes),
    }));
  }

  /**
   * One row: find the artifact again, then take the same claim and the same
   * perform the first dispatch takes.
   *
   * The folder is resolved from the user's *current* settings rather than
   * remembered, because an operator may have moved the backup root since the
   * artifact was written -- and the row carries the copy's identity, not the
   * deployment's layout.
   *
   * `origin` is `automatic` whatever produced the original run. By the time a
   * retry gives up, nobody is reading a "Back up now" response any more; the
   * only way the lost off-machine copy is learned about is the alert.
   */
  private async retryOne(row: DueUpload): Promise<void> {
    const folder = await this.autoBackup.resolveStoredBackupFolder(row.userId);
    await this.dispatch.claimAndPerform({
      userId: row.userId,
      destination: row.destination,
      objectKey: row.objectKey,
      tier: row.tier,
      digest: row.digest,
      sizeBytes: row.sizeBytes,
      folder,
      filename: offsiteArtifactFileName(
        row.destination,
        row.objectKey,
        row.digest,
      ),
      origin: "automatic",
    });
  }
}

/** The message of whatever was thrown, without assuming it was an Error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
