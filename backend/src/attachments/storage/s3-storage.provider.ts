import { Injectable, NotImplementedException } from "@nestjs/common";
import { tr } from "../../i18n/translate";
import { AttachmentStorageProvider } from "./attachment-storage.interface";

/**
 * S3-ready seam for storing attachment bytes in external object storage.
 *
 * Intentionally unimplemented: it establishes the provider contract so a
 * deployment can swap Postgres BYTEA storage for S3/MinIO by binding this
 * provider (ATTACHMENT_STORAGE_PROVIDER=s3) and filling in the AWS SDK calls,
 * without any change to AttachmentsService or the controller. Until then every
 * method refuses rather than silently dropping bytes.
 */
@Injectable()
export class S3StorageProvider implements AttachmentStorageProvider {
  readonly name = "s3";

  private unimplemented(): never {
    throw new NotImplementedException(
      tr(
        "errors.attachments.s3NotImplemented",
        "S3 attachment storage is not yet implemented",
      ),
    );
  }

  async save(_key: string, _data: Buffer): Promise<void> {
    this.unimplemented();
  }

  async load(_key: string): Promise<Buffer> {
    this.unimplemented();
  }

  async delete(_key: string): Promise<void> {
    this.unimplemented();
  }
}
