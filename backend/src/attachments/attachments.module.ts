import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AttachmentsController } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";
import { DatabaseStorageProvider } from "./storage/database-storage.provider";
import { S3StorageProvider } from "./storage/s3-storage.provider";
import { ATTACHMENT_STORAGE_PROVIDER } from "./storage/attachment-storage.interface";

/**
 * Transaction attachments. Bytes are stored via the injected storage provider,
 * selected by ATTACHMENT_STORAGE_PROVIDER (default "database" = Postgres BYTEA;
 * "s3" binds the S3-ready seam). Entities are auto-registered via the datasource
 * glob, so no forFeature is needed -- the service reads repositories from the
 * tenantTx EntityManager.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    DatabaseStorageProvider,
    S3StorageProvider,
    {
      provide: ATTACHMENT_STORAGE_PROVIDER,
      useFactory: (
        config: ConfigService,
        database: DatabaseStorageProvider,
        s3: S3StorageProvider,
      ) => {
        const kind = (
          config.get<string>("ATTACHMENT_STORAGE_PROVIDER") ?? "database"
        ).toLowerCase();
        return kind === "s3" ? s3 : database;
      },
      inject: [ConfigService, DatabaseStorageProvider, S3StorageProvider],
    },
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
