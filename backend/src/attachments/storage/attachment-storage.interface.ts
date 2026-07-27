/**
 * Storage backend for attachment bytes. The metadata row lives in
 * `transaction_attachments`; the bytes live wherever the active provider puts
 * them, addressed by an opaque `key` the provider itself understands.
 *
 * The built-in DatabaseStorageProvider keeps bytes in Postgres. The S3-ready
 * seam (S3StorageProvider) lets a deployment move bytes to object storage
 * without touching the service or controller -- only which provider is bound.
 */
export interface AttachmentStorageProvider {
  /** Stable identifier persisted in `transaction_attachments.storage_provider`. */
  readonly name: string;

  /** Persist bytes under `key`. Joins any ambient transaction (DB provider). */
  save(key: string, data: Buffer): Promise<void>;

  /** Load the bytes stored under `key`. */
  load(key: string): Promise<Buffer>;

  /** Remove the bytes stored under `key`. Idempotent. */
  delete(key: string): Promise<void>;
}

/** DI token for the active AttachmentStorageProvider. */
export const ATTACHMENT_STORAGE_PROVIDER = Symbol(
  "ATTACHMENT_STORAGE_PROVIDER",
);
