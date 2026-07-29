import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "../../../users/entities/user.entity";
import { ImportStagedFile } from "./import-staged-file.entity";
import {
  ImportJobStatus,
  MnyImportProgress,
  MnyImportResult,
} from "../model/mny-import-job";
import { MnyImportOptions } from "../model/mny-import-options";

/**
 * One background import attempt (design ADR-3).
 *
 * The row is the coordination point: `POST /import/mny/start` inserts it
 * `pending`, exactly one worker claims it by moving it to `running`, the running
 * job writes `progress` and `heartbeat_at` in their own short transactions so a
 * poller can see them, and a reaper cron fails jobs whose heartbeat went stale.
 * A failed job keeps `stagedFileId`, so Retry is a new job over the same bytes.
 */
@Entity("import_jobs")
export class ImportJob {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "staged_file_id", nullable: true })
  stagedFileId: string | null;

  // SET NULL, not CASCADE: a completed job's verification report has to outlive
  // the bytes it was produced from, so the TTL sweep must not take import
  // history with it. Declared here as well as in the migration because test and
  // dev databases are synchronized from the entities.
  @ManyToOne(() => ImportStagedFile, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "staged_file_id" })
  stagedFile?: ImportStagedFile | null;

  @Column({
    type: "varchar",
    name: "source_format",
    length: 20,
    default: "mny",
  })
  sourceFormat: string;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: ImportJobStatus;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  options: MnyImportOptions;

  @Column({ type: "jsonb", nullable: true })
  progress: MnyImportProgress | null;

  @Column({ type: "jsonb", nullable: true })
  result: MnyImportResult | null;

  /** i18n key for a failed job. Never a raw message, never a stack. */
  @Column({ type: "varchar", name: "error_key", length: 100, nullable: true })
  errorKey: string | null;

  /** Untranslated diagnostic detail for the log and the failure report. */
  @Column({ type: "text", name: "error_detail", nullable: true })
  errorDetail: string | null;

  /** True when Retry over the same staged file is worth offering. */
  @Column({ name: "retryable", default: false })
  retryable: boolean;

  /** Bumped by the running job; the reaper's liveness signal. */
  @Column({ type: "timestamp", name: "heartbeat_at", nullable: true })
  heartbeatAt: Date | null;

  @Column({ type: "timestamp", name: "started_at", nullable: true })
  startedAt: Date | null;

  @Column({ type: "timestamp", name: "completed_at", nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
