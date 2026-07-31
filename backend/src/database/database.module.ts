import { Module } from "@nestjs/common";
import { SeedService } from "./seed.service";
import { DemoSeedService } from "./demo-seed.service";
import { DemoResetService } from "./demo-reset.service";
import { InstitutionLogoService } from "../institutions/institution-logo.service";

@Module({
  providers: [
    SeedService,
    DemoSeedService,
    DemoResetService,
    InstitutionLogoService,
  ],
  exports: [SeedService, DemoSeedService],
})
export class DatabaseModule {}
