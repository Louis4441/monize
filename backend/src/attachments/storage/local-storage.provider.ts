import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { promises as fs } from "fs";
import { basename, join, resolve } from "path";
import { tr } from "../../i18n/translate";
import { AttachmentStorageProvider } from "./attachment-storage.interface";

/**
 * Stores attachment bytes on the local filesystem under ATTACHMENT_LOCAL_DIR,
 * one file per attachment named by its `key` (the attachment id). Chosen by
 * ATTACHMENT_STORAGE_PROVIDER=local -- a zero-dependency alternative to Postgres
 * BYTEA for deployments that would rather keep large blobs off the database
 * (e.g. a mounted volume) without running object storage.
 *
 * Bytes live outside the database, so they are not embedded in the application
 * backup; only the metadata row travels with a backup and the directory must be
 * backed up alongside it (see .env.example).
 */
@Injectable()
export class LocalStorageProvider implements AttachmentStorageProvider {
  readonly name = "local";
  private readonly baseDir: string;

  constructor(config: ConfigService) {
    this.baseDir = resolve(
      config.get<string>("ATTACHMENT_LOCAL_DIR") ?? "/data/attachments",
    );
  }

  /**
   * Resolve `key` to a path inside `baseDir`. Keys are server-generated UUIDs,
   * but treat them as untrusted: reject anything that isn't a bare filename so a
   * crafted key can never traverse out of the directory.
   */
  private pathFor(key: string): string {
    if (!key || basename(key) !== key) {
      throw new NotFoundException(
        tr("errors.attachments.notFound", "Attachment not found"),
      );
    }
    return join(this.baseDir, key);
  }

  async save(key: string, data: Buffer): Promise<void> {
    const target = this.pathFor(key);
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(target, data);
  }

  async load(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundException(
          tr("errors.attachments.notFound", "Attachment not found"),
        );
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(key));
    } catch (error) {
      // Idempotent: a missing file is already deleted.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
