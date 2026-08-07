import { createHash } from "crypto";

/**
 * Bytes vs. the `byte_size`/`sha256` recorded beside them.
 *
 * One function, four provenances, because the comparison is the same one and a
 * second copy of it would drift. The fourth arrives as a digest rather than as
 * bytes and goes through `attachmentDigestConsistent` below, which is where the
 * comparison actually lives:
 *
 * - **Export, store vs. database** (`BackupExportService.readAttachmentObject`):
 *   the bytes come from the object store and the size/hash from
 *   `transaction_attachments`, so a mismatch means the source object was
 *   truncated, replaced or corrupted out from under its row. The export omits it
 *   rather than packaging bytes it knows the restore will refuse.
 * - **Export, completeness audit** (`auditAttachments`, `export-attachments.ts`):
 *   a database-provider blob that contradicts the metadata travelling beside it,
 *   judged from a digest Postgres computed so the blob never reaches the heap.
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
  return attachmentDigestConsistent(
    {
      byteSize: bytes.length,
      // Lazy: hashing is the expensive half, and a row that declares no checksum
      // never needs it.
      sha256: () => createHash("sha256").update(bytes).digest("hex"),
    },
    row,
  );
}

/**
 * The same comparison, against a digest somebody else computed.
 *
 * The export's completeness check has to judge every `database`-provider blob
 * before the first byte of the download goes out, and pulling each blob onto the
 * heap to hash it is precisely the memory defect issue #1070 closed. So Postgres
 * computes `octet_length` and `sha256` over the column and only those travel --
 * but the *judgement* stays here, because a size-and-checksum comparison written
 * a second time in SQL is a second implementation, and this one has three call
 * sites that must not disagree.
 *
 * `sha256` is a thunk so a caller that already holds the hex string pays nothing
 * and a caller holding bytes hashes only when the row declares a checksum to
 * compare against. It returns `null` when no digest could be computed, which is
 * not the same as a mismatch to ignore: a row that declares a checksum and whose
 * bytes cannot produce one does not describe itself, so it is inconsistent.
 */
export function attachmentDigestConsistent(
  actual: { byteSize: number; sha256: () => string | null },
  row: Record<string, unknown>,
): boolean {
  const declaredSize = Number(row.byte_size);
  if (Number.isFinite(declaredSize) && declaredSize !== actual.byteSize) {
    return false;
  }
  if (typeof row.sha256 === "string" && row.sha256.length > 0) {
    const computed = actual.sha256();
    if (computed === null || computed !== row.sha256) return false;
  }
  return true;
}
