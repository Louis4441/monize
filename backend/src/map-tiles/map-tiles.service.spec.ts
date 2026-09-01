import { MapTilesService, MAX_TILE_ZOOM } from "./map-tiles.service";
import { OSM_USER_AGENT } from "../common/geocoding/osm-user-agent";

function pngResponse(bytes = 64): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as Response;
}

describe("MapTilesService", () => {
  let service: MapTilesService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new MapTilesService();
    fetchMock = jest.fn().mockResolvedValue(pngResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.MAP_TILE_URL_TEMPLATE;
  });

  afterEach(() => jest.restoreAllMocks());

  describe("tile coordinate validation", () => {
    it("accepts a tile inside the 2^z grid", () => {
      expect(MapTilesService.isValidTile(16, 32768, 32768)).toBe(true);
      expect(MapTilesService.isValidTile(0, 0, 0)).toBe(true);
      expect(MapTilesService.isValidTile(MAX_TILE_ZOOM, 0, 0)).toBe(true);
    });

    it.each([
      ["a zoom past the deepest published level", MAX_TILE_ZOOM + 1, 0, 0],
      ["a negative zoom", -1, 0, 0],
      ["an x at the grid width", 2, 4, 0],
      ["a y at the grid height", 2, 0, 4],
      ["a negative x", 5, -1, 0],
      ["a negative y", 5, 0, -1],
      ["a fractional zoom", 1.5, 0, 0],
      ["a fractional x", 5, 1.5, 0],
      ["a NaN", Number.NaN, 0, 0],
    ])("rejects %s", (_label, z, x, y) => {
      expect(MapTilesService.isValidTile(z, x, y)).toBe(false);
    });

    it("never calls out for coordinates that address no tile", async () => {
      await expect(service.getTile(99, 0, 0)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("fetching", () => {
    it("returns the tile bytes and content type", async () => {
      await expect(service.getTile(16, 1, 2)).resolves.toEqual({
        data: expect.any(Buffer),
        contentType: "image/png",
      });
    });

    it("identifies itself, as the tile policy requires", async () => {
      await service.getTile(16, 1, 2);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["User-Agent"]).toBe(
        OSM_USER_AGENT,
      );
    });

    it("substitutes every placeholder in the template", async () => {
      await service.getTile(16, 11, 22);

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://tile.openstreetmap.org/16/11/22.png",
      );
    });

    it("honours MAP_TILE_URL_TEMPLATE so a different provider needs no code change", async () => {
      process.env.MAP_TILE_URL_TEMPLATE =
        "https://tiles.example.test/{z}/{x}/{y}@2x.png";

      await service.getTile(3, 4, 5);

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://tiles.example.test/3/4/5@2x.png",
      );
    });

    it.each([
      [
        "an HTTP error",
        {
          ok: false,
          status: 503,
          headers: { get: () => "image/png" },
        } as unknown as Response,
      ],
      [
        "a non-image response",
        {
          ok: true,
          status: 200,
          headers: { get: () => "text/html; charset=utf-8" },
          arrayBuffer: async () => new Uint8Array(10).buffer,
        } as unknown as Response,
      ],
      ["an empty body", pngResponse(0)],
      ["an oversized body", pngResponse(512 * 1024 + 1)],
    ])("returns null for %s", async (_label, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(service.getTile(16, 1, 2)).resolves.toBeNull();
    });

    it("returns null when the request rejects", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      await expect(service.getTile(16, 1, 2)).resolves.toBeNull();
    });
  });

  describe("caching", () => {
    it("serves a repeated tile without a second upstream request", async () => {
      await service.getTile(16, 1, 2);
      await service.getTile(16, 1, 2);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps tiles apart by coordinate", async () => {
      await service.getTile(16, 1, 2);
      await service.getTile(16, 1, 3);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failure, so a transient outage self-heals", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(service.getTile(16, 1, 2)).resolves.toBeNull();
      await expect(service.getTile(16, 1, 2)).resolves.not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("re-requests once the entry has expired", async () => {
      const clock = { now: 1_000_000 };
      jest.spyOn(Date, "now").mockImplementation(() => clock.now);

      await service.getTile(16, 1, 2);
      clock.now += 7 * 24 * 60 * 60 * 1000 + 1;
      await service.getTile(16, 1, 2);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("evicts the least recently used tile past the cap", async () => {
      for (let i = 0; i < 501; i++) await service.getTile(16, i, 0);
      const afterFill = fetchMock.mock.calls.length;

      await service.getTile(16, 0, 0);

      expect(fetchMock.mock.calls.length).toBe(afterFill + 1);
    });
  });
});
