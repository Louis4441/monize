import { createHash } from "crypto";

/**
 * Bytes vs. the `byte_size`/`sha256` recorded beside them.
 *
 * One function, three provenances, because the comparison is the same one and a
 * second copy of it would drift:
 *
 * - **Export, store vs. database** (`BackupExportService.appendExternalAttachmentBytes`):
 *   the bytes come from the object store and the size/hash from
 *   `transaction_attachments`, so a mismatch means the source object was
 *   truncated, replaced or corrupted out from under its row. The export omits it
 *   rather than packaging bytes it knows the restore will refuse.
 * - **Export, artifact self-check** (`BackupExportService.assessAttachmentCompleteness`):
 *   a database-provider blob that contradicts the metadata travelling beside it.
 * - **Restore, artifact vs. itself** (`BackupAttachmentTransferService.stageAttachmentObjects`):
 *   both sides come from the same file, so this proves consistency rather than authority --
 *   it cannot and does not need to establish ownership, because the bytes are
 *   already in the user's own download. What it catches is a corrupted or
 *   truncated artifact: restoring a row whose recorded `sha256` does not describe
 *   its own bytes would publish a checksum the download cannot satisfy, and the
 *   user would find that out when they opened the file rather than when they
 *   restored it.
 *
 * Both columns are `NOT NULL` in the schema, so on any artifact this codebase
 * produced both checks run and the base64 decode is validated by them -- which
 * matters, because `Buffer.from(value, "base64")` discards characters outside the
 * alphabet instead of failing. A row missing either field is accepted rather than
 * refused: it can only come from a hand-edited or foreign document, and losing
 * bytes that travelled is worse than restoring a row that describes itself less
 * completely than it should.
 */
export function attachmentBytesConsistent(
  bytes: Buffer,
  row: Record<string, unknown>,
): boolean {
  const declaredSize = Number(row.byte_size);
  if (Number.isFinite(declaredSize) && declaredSize !== bytes.length) {
    return false;
  }
  if (typeof row.sha256 === "string" && row.sha256.length > 0) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== row.sha256) return false;
  }
  return true;
}
