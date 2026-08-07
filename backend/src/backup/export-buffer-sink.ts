import { Writable } from "stream";

/**
 * A Writable that collects an export into one Buffer, refusing to grow past a
 * ceiling.
 *
 * Only two callers still need a whole artifact in memory, and neither is an HTTP
 * download: the automatic backup writes a file, and the support export
 * reconciles scaled balances across every table before it serialises anything.
 * Both are bounded by `BACKUP_EXPORT_BUFFER_LIMIT`.
 *
 * **What the ceiling counts changed with issue #1070, and it is now the honest
 * number.** It used to bound the uncompressed JSON, because that JSON really was
 * accumulated -- per-table strings, a concatenated buffer, then gzip's output,
 * all live at the peak. Now the export streams through gzip (and, when
 * encrypted, through the framed container) and this holds only the compressed
 * result, so the limit is measured against the bytes actually resident. That is a
 * more permissive ceiling for compressible data and a stricter one for
 * attachments, which are already-compressed bytes in base64 -- and in both cases
 * it is measuring the thing it is protecting rather than a proxy for it.
 */
export class ExportBufferSink extends Writable {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private lastTable: string | null = null;

  constructor(
    private readonly limitBytes: number,
    private readonly onLimitExceeded: (
      bytes: number,
      table: string | null,
    ) => Error,
  ) {
    super();
  }

  /**
   * The table the pipeline is currently emitting, so the refusal can name where
   * it gave up. An error that says only "too large" tells the user nothing they
   * can act on.
   */
  noteTable(table: string | null): void {
    if (table !== null) this.lastTable = table;
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.total += chunk.length;
    if (this.total > this.limitBytes) {
      // Refuse here rather than after the fact: a ceiling checked once the
      // allocation has happened is not a ceiling.
      done(this.onLimitExceeded(this.total, this.lastTable));
      return;
    }
    this.chunks.push(chunk);
    done();
  }

  /** The collected artifact. Valid once the stream has finished. */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.total);
  }
}
