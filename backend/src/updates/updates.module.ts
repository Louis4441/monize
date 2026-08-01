import { Module } from "@nestjs/common";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";
import { ReleaseNotesService } from "./release-notes.service";
import { ReleaseNotesController } from "./release-notes.controller";
import { WhatsNewService } from "./whats-new.service";
import { WhatsNewController } from "./whats-new.controller";
import { ToursService } from "./tours.service";
import { ToursController } from "./tours.controller";

@Module({
  controllers: [
    UpdatesController,
    ReleaseNotesController,
    WhatsNewController,
    ToursController,
  ],
  providers: [
    UpdatesService,
    ReleaseNotesService,
    WhatsNewService,
    ToursService,
  ],
  exports: [UpdatesService, ReleaseNotesService, WhatsNewService, ToursService],
})
export class UpdatesModule {}
