import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import { MapTilesService } from "./map-tiles.service";

/**
 * Serves map raster tiles from this server, so a payee's map is drawn without
 * the browser contacting a tile provider.
 *
 * Deliberately **not** scoped to a payee. A tile is a square of the world, not
 * anybody's data: every authenticated user may fetch any tile, and a
 * `/payees/:id/tile/...` route would imply a per-payee authorization that does
 * not exist and cannot be enforced (the coordinates are the caller's to choose).
 * Authentication is still required so the proxy is not an open relay.
 */
@ApiTags("Map Tiles")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("map-tiles")
export class MapTilesController {
  constructor(private readonly mapTilesService: MapTilesService) {}

  @Get(":z/:x/:y")
  // A delegate can open the payee page, so it must be able to draw its map.
  @AllowDelegate()
  @ApiOperation({ summary: "Proxy a cached map raster tile" })
  @ApiResponse({ status: 200, description: "Tile image bytes" })
  @ApiResponse({
    status: 404,
    description: "No such tile, or it is unavailable",
  })
  async getTile(
    @Param("z", ParseIntPipe) z: number,
    @Param("x", ParseIntPipe) x: number,
    @Param("y", ParseIntPipe) y: number,
    @Res() res: Response,
  ): Promise<void> {
    const tile = await this.mapTilesService.getTile(z, x, y);
    // A tile that does not exist and one the provider would not give us are the
    // same answer to the client: draw nothing there. The map's <img> hides
    // itself on error, so a gap costs a square of background, not a broken page.
    if (!tile) throw new NotFoundException("Tile not available");

    res.set({
      "Content-Type": tile.contentType,
      "Content-Length": String(tile.data.length),
      // Tiles at a fixed zoom rarely change; a day in the browser removes
      // almost every repeat request from this server as well as from upstream.
      "Cache-Control": "private, max-age=86400",
    });
    res.end(tile.data);
  }
}
