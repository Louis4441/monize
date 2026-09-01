import { Injectable, Logger } from "@nestjs/common";
import { describeFetchFailure } from "../common/http/fetch-failure.util";
import { OSM_USER_AGENT } from "../common/geocoding/osm-user-agent";

export interface MapTile {
  data: Buffer;
  contentType: string;
}

/** Default raster source. Overridden with `MAP_TILE_URL_TEMPLATE`. */
const DEFAULT_TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** The deepest zoom served. OSM publishes tiles to 19. */
export const MAX_TILE_ZOOM = 19;

/**
 * Fetches and caches map raster tiles so the browser never contacts a tile
 * server itself -- the same rule brand favicons follow, and a hard requirement
 * here because the frontend's CSP is nonce-based `strict-dynamic` and would
 * block a third-party image outright.
 *
 * ## Staying inside the tile server's usage policy
 *
 * OpenStreetMap's policy forbids "heavy use" and bulk downloading, and requires
 * a User-Agent identifying the application. What keeps this deployment far
 * below any threshold is that a tile is fetched **once per instance**: every
 * user viewing any payee near the same place is served from this cache, and the
 * browser holds it for a further day through `Cache-Control`. A payee's map is
 * nine tiles at one fixed zoom, so a household's whole usage is a few dozen
 * requests that mostly never repeat.
 */
@Injectable()
export class MapTilesService {
  private readonly logger = new Logger(MapTilesService.name);

  private static readonly TIMEOUT_MS = 6000;
  /** A 256px PNG tile is tens of KB; the cap guards a misbehaving upstream. */
  private static readonly MAX_BYTES = 512 * 1024;
  private static readonly CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  /** ~500 tiles of a few tens of KB each: single-digit MB of process memory. */
  private static readonly CACHE_MAX_ENTRIES = 500;

  /** Insertion-ordered, so the first key is the least recently used entry. */
  private readonly cache = new Map<
    string,
    { tile: MapTile; expiresAt: number }
  >();

  /**
   * Whether these tile coordinates exist at all. `x` and `y` index a 2^z grid,
   * so anything outside it addresses no tile -- and since the values are
   * interpolated into an outbound URL, rejecting them here is also what stops a
   * request being steered somewhere the template did not intend.
   */
  static isValidTile(z: number, x: number, y: number): boolean {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
      return false;
    }
    if (z < 0 || z > MAX_TILE_ZOOM) return false;
    const limit = 2 ** z;
    return x >= 0 && x < limit && y >= 0 && y < limit;
  }

  /**
   * A tile, from cache when possible. Returns null on any failure so the caller
   * can 404 and the map simply renders that square blank -- a missing tile is
   * a cosmetic gap, never an error worth failing a page load over.
   */
  async getTile(z: number, x: number, y: number): Promise<MapTile | null> {
    if (!MapTilesService.isValidTile(z, x, y)) return null;

    const key = `${z}/${x}/${y}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.tile;
    }
    if (cached) this.cache.delete(key);

    const tile = await this.fetchTile(key);
    if (tile) this.remember(key, tile);
    return tile;
  }

  private remember(key: string, tile: MapTile): void {
    this.cache.set(key, {
      tile,
      expiresAt: Date.now() + MapTilesService.CACHE_TTL_MS,
    });
    while (this.cache.size > MapTilesService.CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /** Build the upstream URL for `z/x/y`. Exposed for the spec. */
  static tileUrl(z: number, x: number, y: number): string {
    const template = process.env.MAP_TILE_URL_TEMPLATE || DEFAULT_TILE_TEMPLATE;
    return template
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }

  /** The outbound request. Never throws. */
  private async fetchTile(key: string): Promise<MapTile | null> {
    const [z, x, y] = key.split("/").map(Number);
    const url = MapTilesService.tileUrl(z, x, y);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      MapTilesService.TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        // The tile policy requires a request to identify its application.
        headers: { "User-Agent": OSM_USER_AGENT },
      });

      if (!response.ok) {
        this.logger.warn(`Map tile ${key} returned HTTP ${response.status}`);
        return null;
      }

      const rawContentType = response.headers.get("content-type") || "";
      const contentType = rawContentType.split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) {
        this.logger.warn(
          `Map tile ${key} returned non-image content-type "${rawContentType}"`,
        );
        return null;
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0 || data.length > MapTilesService.MAX_BYTES) {
        this.logger.warn(`Map tile ${key} returned ${data.length} bytes`);
        return null;
      }

      return { data, contentType };
    } catch (error) {
      this.logger.warn(
        `Map tile ${key} failed: ${describeFetchFailure(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
