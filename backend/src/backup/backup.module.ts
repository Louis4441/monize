import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BackupController } from "./backup.controller";
import { AutoBackupController } from "./auto-backup.controller";
import { BackupService } from "./backup.service";
import { BackupExportService } from "./backup-export.service";
import { BackupRestoreService } from "./backup-restore.service";
import { BackupAttachmentTransferService } from "./backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";
import { AutoBackupService } from "./auto-backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { SupportBackupService } from "./support-backup/support-backup.service";
import { AuthModule } from "../auth/auth.module";
import { AiModule } from "../ai/ai.module";
import { AttachmentsModule } from "../attachments/attachments.module";

@Module({
  imports: [AuthModule, AiModule, ConfigModule, AttachmentsModule],
  controllers: [BackupController, AutoBackupController],
  providers: [
    // The four components issue #1092 split BackupService into; BackupService
    // itself is now the facade over the first two.
    BackupExportService,
    BackupRestoreService,
    BackupAttachmentTransferService,
    BackupRestoreDatabaseService,
    BackupService,
    AutoBackupService,
    BackupEncryptionService,
    SupportBackupService,
  ],
  exports: [BackupEncryptionService],
})
export class BackupModule {}
