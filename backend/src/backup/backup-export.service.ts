import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { createGzip, gzipSync } from "zlib";
import { withScopedDb } from "../common/db/scoped-db";
import {
  ATTACHMENT_STORAGE_PROVIDER,
  AttachmentStorageProvider,
} from "../attachments/storage/attachment-storage.interface";
import { encryptBackup } from "./backup-crypto.util";
import { resolveConfiguredBackupLimit } from "./backup-limits";
import { attachmentBytesConsistent } from "./attachment-integrity.util";
import { BACKUP_VERSION, BackupCompletenessReport } from "./backup-format";
import {
  buildExportTableQueries,
  ExportRead,
  ExportTableQuery,
  INTENTIONALLY_EXCLUDED_TABLES,
} from "./export-table-queries";
import { tr } from "../i18n/translate";

/**
 * Everything that reads a user's data out into a backup artifact: the
 * `REPEATABLE READ` snapshot every table is read under, the per-table queries,
 * the streamed and buffered assemblies, the attachment bytes an object store has
 * to contribute, and the completeness report that says whether the artifact is
 * a backup of everything it names.
 *
 * Split out of `BackupService` (issue #1092). It knows nothing about restore:
 * the only thing the two halves share is the file format in `backup-format.ts`.
 */
@Injectable()
export class BackupExportService {
  private readonly logger = new Logger(BackupExportService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(ATTACHMENT_STORAGE_PROVIDER)
    private readonly attachmentStorage: AttachmentStorageProvider,
  ) {}

  /** Ceiling on the JSON a buffered export may accumulate. */
  get exportBufferLimitBytes(): number {
    return resolveConfiguredBackupLimit(
      "BACKUP_EXPORT_BUFFER_LIMIT",
      process.env.BACKUP_EXPORT_BUFFER_LIMIT,
      (message) => this.logger.warn(message),
    );
  }

  /** The export's table list, with the attachment-bytes augmentation bound. */
  private getTableQueries(): ExportTableQuery[] {
    return buildExportTableQueries((rows, read) =>
      this.appendExternalAttachmentBytes(rows, read),
    );
  }

  /**
   * Produces the full backup file as a Buffer -- gzipped JSON, optionally
   * encrypted -- alongside a report of whether every attachment's bytes made it
   * in. Used by the auto-backup path, which must not promote or retain an
   * incomplete artifact as if it were complete.
   */
  async exportToBuffer(
    userId: string,
    encryptionPassword?: string,
  ): Promise<{ buffer: Buffer; report: BackupCompletenessReport }> {
    const { buffer, report } = await this.collectGzippedExport(userId);
    return {
      buffer: encryptionPassword
        ? await encryptBackup(buffer, encryptionPassword)
        : buffer,
      report,
    };
  }

  async streamExport(
    userId: string,
    res: import("express").Response,
    encryptionPassword?: string,
  ): Promise<void> {
    this.logger.log(
      `Starting backup export for user ${userId}${encryptionPassword ? " (encrypted)" : ""}`,
    );

    // Encrypted exports require the full payload up-front to compute the GCM
    // auth tag, so we buffer JSON in memory before encrypting. Plain exports
    // pipe through gzip instead, which avoids holding the whole *compressed*
    // artifact -- but not the whole dataset: each table is still read into an
    // array and serialised with one `JSON.stringify`, and every carried
    // attachment is base64-encoded into one array before that. Peak memory
    // therefore tracks dataset size, not chunk size (F3RB-006, issue #1070, whose
    // closure needs a cursor inside the snapshot and per-attachment
    // encoding). Do not read this path as bounded.
    if (encryptionPassword) {
      const { buffer, report } = await this.collectGzippedExport(userId);
      // Nothing has been sent yet, so the incompleteness can be *in the
      // response* rather than only in the log (F3RB-004).
      this.warnIfIncompleteExport(userId, report);
      this.markIncompleteExport(res, report);
      const encrypted = await encryptBackup(buffer, encryptionPassword);
      res.write(encrypted);
      res.end();
      this.logger.log(`Backup export completed for user ${userId} (encrypted)`);
      return;
    }

    const tableQueries = this.getTableQueries();

    // Write JSON through gzip to the response one table at a time. This bounds
    // the compressed output and the number of tables held at once -- it does NOT
    // bound one table, or the carried attachment set (F3RB-006).
    const gzip = createGzip();
    let responseAbort: Error | null = null;
    const abortResponse = (error: Error): void => {
      if (responseAbort === null) responseAbort = error;
      // Rejecting the pending operation releases the snapshot transaction; the
      // transform is destroyed separately so it cannot retain buffered output.
      if (!gzip.destroyed) gzip.destroy();
    };
    const onResponseClose = (): void => {
      if (!res.writableFinished) {
        abortResponse(
          new Error("Backup export response closed before completion"),
        );
      }
    };
    const onResponseError = (error: Error): void => abortResponse(error);
    res.once("close", onResponseClose);
    res.once("error", onResponseError);

    /**
     * One gzip operation that cannot wait forever after the response disappears.
     * The write callback replaces a naked `drain` wait: `close` and `error` reject
     * it, so `inExportSnapshot` unwinds and withScopedDb releases the transaction.
     */
    const gzipOperation = (
      start: (done: (error?: Error | null) => void) => void,
    ): Promise<void> =>
      new Promise((resolve, reject) => {
        if (responseAbort !== null) {
          reject(responseAbort);
          return;
        }
        let settled = false;
        const cleanup = (): void => {
          res.off("close", onClose);
          res.off("error", onError);
          gzip.off("error", onError);
        };
        const done = (error?: Error | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const onClose = (): void =>
          done(
            responseAbort ??
              new Error("Backup export response closed before completion"),
          );
        const onError = (error: Error): void => done(error);
        res.once("close", onClose);
        res.once("error", onError);
        gzip.once("error", onError);
        try {
          start(done);
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      });

    const write = (chunk: string): Promise<void> =>
      gzipOperation((done) => {
        gzip.write(chunk, done);
      });

    let completed = false;
    try {
      const preRead = new Map<string, Record<string, unknown>[]>();
      await this.inExportSnapshot(userId, async (read) => {
        // Read the two attachment tables BEFORE the first byte goes out, so
        // completeness can be signalled in the response headers rather than only
        // in the log (F3RB-004). This costs no extra memory: both arrays were
        // already retained for the end-of-stream assessment, so the only change
        // is the order in which they are read inside the same snapshot.
        for (const entry of tableQueries) {
          if (
            entry.key === "transaction_attachments" ||
            entry.key === "attachment_blobs"
          ) {
            preRead.set(entry.key, await this.readTable(read, entry));
          }
        }
        const attachments = preRead.get("transaction_attachments") ?? [];
        const blobs = preRead.get("attachment_blobs") ?? [];
        const report = this.assessAttachmentCompleteness(attachments, blobs);
        this.warnIfIncompleteExport(userId, report);
        this.markIncompleteExport(res, report);

        // Only now does anything reach the socket, so the headers above are still
        // mutable.
        gzip.pipe(res);
        await write(
          `{"version":${BACKUP_VERSION},"exportedAt":"${new Date().toISOString()}"`,
        );

        for (const entry of tableQueries) {
          const rows =
            preRead.get(entry.key) ?? (await this.readTable(read, entry));
          await write(`,"${entry.key}":${JSON.stringify(rows)}`);
        }

        await write(this.completenessEnvelopeTail(report));
      });

      await gzipOperation((done) => {
        gzip.end(() => done());
      });
      completed = true;
    } finally {
      res.off("close", onResponseClose);
      res.off("error", onResponseError);
      if (!completed && !gzip.destroyed) gzip.destroy();
    }

    this.logger.log(`Backup export completed for user ${userId}`);
  }

  /**
   * Tell the client, in the response itself, that this artifact is incomplete
   * (F3RB-004).
   *
   * A download that the backend knows cannot restore everything it names used to
   * arrive as an ordinary 200 with the ordinary filename and an ordinary success
   * toast -- so a user could delete the source system on the strength of it. The
   * bytes are still sent, deliberately: a partial artifact is worth more than no
   * artifact when the alternative is losing the rest too. What changes is that it
   * cannot be mistaken for a complete one.
   *
   * Headers rather than the body because the body is a gzip/encrypted stream with
   * no place to put a status, and because this must work for the streaming path
   * where nothing can be added afterwards. `Content-Disposition` is rewritten so
   * the file on disk carries the warning too -- a header is invisible six months
   * later, a filename is not. Called before the first byte on both paths.
   */
  private markIncompleteExport(
    res: import("express").Response,
    report: BackupCompletenessReport,
  ): void {
    if (report.complete) return;
    res.setHeader("X-Backup-Complete", "false");
    res.setHeader(
      "X-Backup-Attachments-Expected",
      String(report.expectedAttachments),
    );
    res.setHeader(
      "X-Backup-Attachments-Included",
      String(report.includedAttachments),
    );
    res.setHeader(
      "X-Backup-Attachments-Missing",
      String(report.missingAttachments),
    );
    res.setHeader(
      "X-Backup-Attachments-Inconsistent",
      String(report.inconsistentAttachments),
    );
    // CORS: a browser cannot read a custom response header unless it is exposed.
    res.setHeader(
      "Access-Control-Expose-Headers",
      [
        "Content-Disposition",
        "X-Backup-Complete",
        "X-Backup-Attachments-Expected",
        "X-Backup-Attachments-Included",
        "X-Backup-Attachments-Missing",
        "X-Backup-Attachments-Inconsistent",
      ].join(", "),
    );

    const disposition = res.getHeader("Content-Disposition");
    if (typeof disposition === "string") {
      res.setHeader(
        "Content-Disposition",
        disposition.replace(
          /filename="([^"]+?)(\.json\.gz|\.mzbe)"/,
          'filename="$1-INCOMPLETE$2"',
        ),
      );
    }
  }

  /** Logs an incomplete manual export; the auto-backup path acts on it instead. */
  private warnIfIncompleteExport(
    userId: string,
    report: BackupCompletenessReport,
  ): void {
    if (report.complete) return;
    this.logger.warn(
      `Backup export for user ${userId} is incomplete: ` +
        `${report.missingAttachments} attachment(s) could not be included and ` +
        `${report.inconsistentAttachments} did not match their metadata, of ` +
        `${report.expectedAttachments} total. The artifact is not a complete ` +
        `backup of those attachments.`,
    );
  }

  /**
   * Runs `fn` with a reader bound to one consistent database snapshot.
   *
   * Every table query used to open its own short transaction, so the export saw
   * a different committed state per table -- and a backup taken while the user
   * was active could contain a child without its parent. Add an account and a
   * transaction for it between the `accounts` query and the `transactions`
   * query, and the artifact holds the transaction alone: valid gzip, valid
   * envelope, and a restore that fails on `transactions.account_id`. Other
   * interleavings drop dependent rows with no error at all.
   *
   * `REPEATABLE READ` fixes the snapshot at the transaction's first statement,
   * so every table is read as of one instant. READ COMMITTED would not do, even
   * inside a single transaction: it takes a fresh snapshot per statement, which
   * is the same problem with fewer transactions.
   *
   * The cost is a transaction held for the length of the export -- for the
   * streaming path, for the length of the download. That is one pooled
   * connection and a held xmin, which is the price of a backup that restores.
   */
  private inExportSnapshot<T>(
    userId: string,
    fn: (
      read: (sql: string) => Promise<Record<string, unknown>[]>,
    ) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(
      this.dataSource,
      (manager) => fn((sql) => manager.query(sql, [userId])),
      "REPEATABLE READ",
    );
  }

  /**
   * The set of tables the export writes (and the restore repopulates). Exposed
   * so the coverage guard test can assert every database table is either backed
   * up or explicitly excluded (see INTENTIONALLY_EXCLUDED_TABLES).
   */
  getBackedUpTableNames(): string[] {
    return this.getTableQueries().map((q) => q.key);
  }

  /** The tables deliberately omitted from backups, exposed for the guard test. */
  getIntentionallyExcludedTableNames(): string[] {
    return Array.from(INTENTIONALLY_EXCLUDED_TABLES);
  }

  /**
   * Collects the full export as an in-memory map of table -> rows, using the
   * same queries as the streamed/gzipped export. Consumed by the support
   * (de-identified) backup, which must hold every table at once to reconcile
   * scaled balances before serializing. Returns the same version/exportedAt
   * envelope fields the file format uses.
   */
  async collectRawExport(
    userId: string,
    options: { skipTables?: ReadonlySet<string> } = {},
  ): Promise<{
    version: number;
    exportedAt: string;
    tables: Record<string, Record<string, unknown>[]>;
  }> {
    const tables: Record<string, Record<string, unknown>[]> = {};
    await this.inExportSnapshot(userId, async (read) => {
      for (const entry of this.getTableQueries()) {
        const key = entry.key;
        // A caller that will discard a table must not pay to load it. The
        // support backup always excludes `attachment_blobs`, which is base64 --
        // thirty 10 MiB receipts are ~400 MiB of text, the whole of the chart's
        // default backend limit, fetched and thrown away before any ceiling was
        // consulted. Skipping the query is the only fix that helps: a budget
        // checked after the allocation is a budget checked too late.
        if (options.skipTables?.has(key)) continue;
        tables[key] = await this.readTable(read, entry);
      }
    });
    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables,
    };
  }

  /** Reads one export table, applying its augmentation if it has one. */
  private async readTable(
    read: ExportRead,
    entry: ExportTableQuery,
  ): Promise<Record<string, unknown>[]> {
    const rows = await read(entry.sql);
    return entry.augment ? await entry.augment(rows, read) : rows;
  }

  /**
   * Adds the `local` and `s3` providers' attachment bytes to `attachment_blobs`.
   *
   * **A backup that cannot restore an attachment is not a backup of it.** Only
   * `database`-provider bytes used to travel; for `local` and `s3` the artifact
   * carried metadata and the operator was told to restore the sidecar volume or
   * bucket alongside it. That works only while the *target* database still holds
   * the matching row, because the restore has to prove the caller is entitled to
   * read the object before it reads it -- and after the ownership fix, the proof
   * is a current `transaction_attachments` row. So the two cases backups exist for
   * both failed: a fresh instance has no such row, and an account whose
   * attachment was deleted has no such row either. The restore reported success
   * and counted the attachment as skipped.
   *
   * There is no way to fix that with a better ownership check. An identifier, a
   * size and a hash in an uploaded document cannot establish a right to read an
   * object, however they are combined -- that is what the last two rounds
   * established. The only thing that can is the bytes being *in* the artifact the
   * user downloaded, which is what this does.
   *
   * What it costs: the artifact grows by the size of the attachments, and this
   * method accumulates every carried object in memory before serialization. On the
   * encrypted, automatic and support paths that is bounded by
   * `BACKUP_EXPORT_BUFFER_LIMIT`, so a large attachment set is refused with the
   * readable error rather than silently producing a file whose attachments cannot
   * come back. **The plain export is *not* bounded** -- it was the streaming path,
   * and this accumulation is a real hole in that claim (F3R6-001). Fixing it is the
   * same cursor/one-object-at-a-time work as bounding the large-table reads
   * (`docs/backup-restore-contract.md`, still open); until then, a plain export of
   * a very large attachment set can exceed the pod. The bytes must travel for the
   * backup to be a backup, so the accumulation is a known cost, not a regression to
   * revert.
   *
   * Two things are checked, not just loaded. An object the store cannot produce is
   * logged and omitted -- the ledger is the point of a backup, and refusing the
   * whole file over one unreadable receipt would leave the user with nothing. And
   * an object whose bytes no longer match the size and SHA-256 the server recorded
   * for it is also omitted (`attachmentBytesConsistent`): export is the last moment
   * to notice the source is already corrupt, and packaging bytes the restore will
   * refuse would report a success the artifact cannot honour.
   */
  private async appendExternalAttachmentBytes(
    rows: Record<string, unknown>[],
    read: ExportRead,
  ): Promise<Record<string, unknown>[]> {
    const provider = this.attachmentStorage.name;
    // The `database` provider's bytes are already in the rows the query returned.
    if (provider === "database") return rows;

    const metadata = await read(
      `SELECT id, storage_provider, byte_size, sha256
         FROM transaction_attachments
        WHERE user_id = $1
        ORDER BY id`,
    );

    const carried: Record<string, unknown>[] = [];
    let unreadable = 0;
    let inconsistent = 0;
    for (const row of metadata) {
      // Rows written by a different backend than this runtime configures cannot
      // be read from here at all; they keep travelling as metadata only.
      if (String(row.storage_provider ?? "") !== provider) continue;
      const id = String(row.id ?? "");
      let bytes: Buffer;
      try {
        bytes = await this.attachmentStorage.load(id);
      } catch {
        unreadable += 1;
        continue;
      }
      // The object must match the size and hash the server recorded for it. This
      // is the last moment the discrepancy can be seen: the restore checks the
      // same thing (`attachmentBytesConsistent`) and would drop the row, but by
      // then the export has reported success and the user believes the receipt is
      // safe. So a source object that no longer matches its metadata -- truncated,
      // replaced, silently corrupted in the volume or bucket -- is omitted here
      // and never packaged. The metadata is the server's own record; the bytes
      // are what the store returned, so this compares the store against the
      // database rather than the file against itself.
      if (!attachmentBytesConsistent(bytes, row)) {
        inconsistent += 1;
        continue;
      }
      carried.push({ attachment_id: id, data: bytes.toString("base64") });
    }

    if (unreadable > 0) {
      this.logger.warn(
        `Backup export could not read ${unreadable} attachment object(s) from the ` +
          `${provider} store; their metadata travels without bytes and they will ` +
          `not be restorable.`,
      );
    }
    if (inconsistent > 0) {
      this.logger.warn(
        `Backup export found ${inconsistent} attachment object(s) in the ${provider} ` +
          `store whose bytes no longer match their recorded size or checksum; they ` +
          `are omitted and will not be restorable from this artifact.`,
      );
    }
    if (carried.length > 0) {
      this.logger.log(
        `Backup export carried ${carried.length} external attachment object(s) ` +
          `from the ${provider} store.`,
      );
    }
    // Immutability: a new array rather than pushing into the caller's.
    return [...rows, ...carried];
  }

  /**
   * Builds the gzipped JSON backup payload as a single Buffer in memory.
   * Used by the encryption path (which needs the whole payload to compute
   * the GCM auth tag) and the auto-backup writer.
   *
   * Buffers rather than strings, concatenated once: `parts.join("")` followed by
   * `Buffer.from(..., "utf-8")` held the whole payload twice at the moment of
   * conversion -- once as a JS string, once as bytes -- on top of the per-table
   * strings and the gzip output. On the chart's default 400 MiB backend that is
   * the difference between a backup and an OOM kill.
   *
   * The running total is checked against `exportBufferLimitBytes` as it grows, so
   * a dataset too large for this path is refused with an error the user can read
   * rather than by the pod dying mid-write. The unencrypted HTTP export is
   * unaffected: it streams, and has no total to bound.
   */
  private async collectGzippedExport(
    userId: string,
  ): Promise<{ buffer: Buffer; report: BackupCompletenessReport }> {
    const tableQueries = this.getTableQueries();
    const parts: Buffer[] = [
      Buffer.from(
        `{"version":${BACKUP_VERSION},"exportedAt":"${new Date().toISOString()}"`,
        "utf-8",
      ),
    ];
    let total = parts[0].length;
    // Captured to judge completeness after assembly: the metadata rows and the
    // blob rows the augment actually included.
    let attachments: Record<string, unknown>[] = [];
    let blobs: Record<string, unknown>[] = [];
    await this.inExportSnapshot(userId, async (read) => {
      for (const entry of tableQueries) {
        const key = entry.key;
        const rows = await this.readTable(read, entry);
        if (key === "transaction_attachments") attachments = rows;
        else if (key === "attachment_blobs") blobs = rows;
        const chunk = Buffer.from(`,"${key}":${JSON.stringify(rows)}`, "utf-8");
        total += chunk.length;
        if (total > this.exportBufferLimitBytes) {
          throw new BadRequestException(
            tr(
              "errors.backup.exportTooLarge",
              `This backup is too large to produce in one piece (past ${this.exportBufferLimitBytes} bytes at table "${key}"). Encrypted, automatic and support backups have to be assembled in memory; use the plain export, which streams, or raise BACKUP_EXPORT_BUFFER_LIMIT.`,
              { limit: this.exportBufferLimitBytes, table: key },
            ),
          );
        }
        parts.push(chunk);
      }
    });
    const report = this.assessAttachmentCompleteness(attachments, blobs);
    parts.push(Buffer.from(this.completenessEnvelopeTail(report), "utf-8"));
    return { buffer: gzipSync(Buffer.concat(parts)), report };
  }

  /**
   * The closing brace, with the completeness claim in front of it.
   *
   * At the tail rather than beside `version` because the buffered path cannot
   * know the answer until every table has been read -- and one placement for
   * both paths means a reader never has to care which produced the file. JSON
   * member order carries no meaning; `data.completeness` reads the same either
   * way.
   *
   * Written for a complete artifact too. "This file says it is complete" and
   * "this file says nothing" are different facts about a recovered artifact, and
   * only the first of them is evidence (`parseArtifactCompleteness`).
   */
  private completenessEnvelopeTail(report: BackupCompletenessReport): string {
    return `,"completeness":${JSON.stringify(report)}}`;
  }

  /**
   * Judges whether every attachment metadata row in the artifact has its bytes.
   *
   * Runs after assembly, over the two arrays actually written. A metadata row
   * with no matching blob is *missing* -- the augment dropped an external object
   * it could not read or that failed its checksum, or a database blob simply is
   * not there. A database-provider blob that is present but contradicts its own
   * metadata is *inconsistent*; external blobs were already validated when the
   * augment carried them, so their presence is proof enough and they are not
   * re-hashed here. Support backups exclude the attachment tables, so there are no
   * rows and the report is trivially complete.
   */
  private assessAttachmentCompleteness(
    attachments: Record<string, unknown>[],
    blobs: Record<string, unknown>[],
  ): BackupCompletenessReport {
    const blobById = new Map<string, string>();
    for (const blob of blobs ?? []) {
      const id = String(blob.attachment_id ?? "");
      if (id.length > 0 && typeof blob.data === "string") {
        blobById.set(id, blob.data);
      }
    }

    let missing = 0;
    let inconsistent = 0;
    for (const row of attachments ?? []) {
      const id = String(row.id ?? "");
      const encoded = blobById.get(id);
      if (encoded === undefined) {
        missing += 1;
        continue;
      }
      // Only the database provider's bytes arrive here unvalidated; external ones
      // passed `attachmentBytesConsistent` before the augment included them.
      if (String(row.storage_provider ?? "database") === "database") {
        const bytes = Buffer.from(encoded, "base64");
        if (!attachmentBytesConsistent(bytes, row)) inconsistent += 1;
      }
    }

    const expected = attachments?.length ?? 0;
    const included = expected - missing - inconsistent;
    return {
      complete: missing === 0 && inconsistent === 0,
      expectedAttachments: expected,
      includedAttachments: included,
      missingAttachments: missing,
      inconsistentAttachments: inconsistent,
    };
  }
}
