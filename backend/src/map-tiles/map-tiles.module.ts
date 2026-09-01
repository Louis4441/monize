import { Module } from "@nestjs/common";
import { MapTilesController } from "./map-tiles.controller";
import { MapTilesService } from "./map-tiles.service";

@Module({
  controllers: [MapTilesController],
  providers: [MapTilesService],
  exports: [MapTilesService],
})
export class MapTilesModule {}
