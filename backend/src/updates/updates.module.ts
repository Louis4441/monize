import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";
import { ReleaseNotesService } from "./release-notes.service";
import { ReleaseNotesController } from "./release-notes.controller";
import { WhatsNewService } from "./whats-new.service";
import { WhatsNewController } from "./whats-new.controller";

@Module({
  imports: [TypeOrmModule.forFeature([UserPreference])],
  controllers: [UpdatesController, ReleaseNotesController, WhatsNewController],
  providers: [UpdatesService, ReleaseNotesService, WhatsNewService],
  exports: [UpdatesService, ReleaseNotesService, WhatsNewService],
})
export class UpdatesModule {}
