import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { promises as fs } from "fs";
import { basename, resolve, sep } from "path";
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
   * Keys are server-generated UUIDs. The allowlist deliberately excludes `.`,
   * so traversal segments (`.`, `..`) and separators cannot be expressed at all.
   */
  private static readonly SAFE_KEY = /^[A-Za-z0-9_-]+$/;

  /**
   * Resolve `key` to a path inside `baseDir`. Keys are server-generated, but
   * treat them as untrusted: strip any directory component, require the result
   * to be an unchanged allowlisted filename, then assert the resolved path is
   * still contained by `baseDir` before it reaches the filesystem.
   */
  private pathFor(key: string): string {
    const safe = basename(key ?? "");
    if (
      !safe ||
      safe !== key ||
      !LocalStorageProvider.SAFE_KEY.test(safe) ||
      safe.includes("\0")
    ) {
      throw new NotFoundException(
        tr("errors.attachments.notFound", "Attachment not found"),
      );
    }
    const target = resolve(this.baseDir, safe);
    if (!target.startsWith(`${this.baseDir}${sep}`)) {
      throw new NotFoundException(
        tr("errors.attachments.notFound", "Attachment not found"),
      );
    }
    return target;
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
