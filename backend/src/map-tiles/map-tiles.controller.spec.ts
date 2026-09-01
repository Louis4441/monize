import { NotFoundException } from "@nestjs/common";
import { Response } from "express";
import { MapTilesController } from "./map-tiles.controller";
import { MapTilesService } from "./map-tiles.service";

describe("MapTilesController", () => {
  let controller: MapTilesController;
  let service: jest.Mocked<Pick<MapTilesService, "getTile">>;
  let res: { set: jest.Mock; end: jest.Mock };

  beforeEach(() => {
    service = { getTile: jest.fn() };
    controller = new MapTilesController(service as unknown as MapTilesService);
    res = { set: jest.fn(), end: jest.fn() };
  });

  it("streams the tile bytes with its content type", async () => {
    const data = Buffer.from([1, 2, 3, 4]);
    service.getTile.mockResolvedValue({ data, contentType: "image/png" });

    await controller.getTile(16, 1, 2, res as unknown as Response);

    expect(service.getTile).toHaveBeenCalledWith(16, 1, 2);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Type": "image/png",
        "Content-Length": "4",
      }),
    );
    expect(res.end).toHaveBeenCalledWith(data);
  });

  it("lets the browser cache a tile, which is most of what keeps upstream traffic down", async () => {
    service.getTile.mockResolvedValue({
      data: Buffer.from([1]),
      contentType: "image/png",
    });

    await controller.getTile(16, 1, 2, res as unknown as Response);

    expect(res.set.mock.calls[0][0]["Cache-Control"]).toBe(
      "private, max-age=86400",
    );
  });

  it("404s an unavailable tile rather than failing the page", async () => {
    service.getTile.mockResolvedValue(null);

    await expect(
      controller.getTile(16, 1, 2, res as unknown as Response),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(res.end).not.toHaveBeenCalled();
  });
});
