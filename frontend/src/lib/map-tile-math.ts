/**
 * Web Mercator tile arithmetic for the payee location map.
 *
 * A slippy map is a grid of 256px images: at zoom z the world is 2^z tiles
 * across, and a lat/lng maps to a pixel in that grid. There is no map library
 * here on purpose -- the frontend loads no third-party script or image (the CSP
 * is nonce-based `strict-dynamic`, and the tiles come from our own backend), so
 * the handful of formulas a fixed-zoom static map needs live here instead.
 */

/**
 * The zoom every payee map renders at. Street level: close enough to see which
 * building, wide enough to recognise the neighbourhood. Fixed rather than
 * user-controlled because a pannable map would fetch tiles as the user drags,
 * which is the "heavy use" the tile policy asks deployments not to make.
 */
export const MAP_TILE_ZOOM = 16;

/** Edge length of one tile image, in CSS pixels. */
export const TILE_SIZE = 256;

export interface TilePlacement {
  z: number;
  x: number;
  y: number;
  /** Offset from the marker point, in pixels, for absolute positioning. */
  left: number;
  top: number;
}

/**
 * The pixel coordinates of a lat/lng in the whole-world grid at zoom `z`.
 *
 * The latitude term is the Mercator projection: y is the log-tangent of the
 * latitude, which is why the poles are unreachable and why latitudes beyond
 * about +/-85 degrees are clamped by callers rather than projected.
 */
export function globalPixel(
  lat: number,
  lng: number,
  z: number,
): { x: number; y: number } {
  const worldSize = 2 ** z * TILE_SIZE;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = ((lng + 180) / 360) * worldSize;
  const rad = (clampedLat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    worldSize;
  return { x, y };
}

/**
 * The 3x3 block of tiles surrounding a point, each positioned relative to that
 * point.
 *
 * Nine tiles cover at least 384px in every direction from the marker, which is
 * more than the card ever shows -- so the map fills its frame without measuring
 * the container, at any card size the layout produces. Tiles falling outside
 * the world grid (near a pole, or at the date line) are dropped rather than
 * requested: they address no image, and the gap renders as background.
 */
export function tilesAround(
  lat: number,
  lng: number,
  z: number = MAP_TILE_ZOOM,
): TilePlacement[] {
  const { x, y } = globalPixel(lat, lng, z);
  const centerTileX = Math.floor(x / TILE_SIZE);
  const centerTileY = Math.floor(y / TILE_SIZE);
  const gridSize = 2 ** z;
  const tiles: TilePlacement[] = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tileX = centerTileX + dx;
      const tileY = centerTileY + dy;
      if (tileX < 0 || tileY < 0 || tileX >= gridSize || tileY >= gridSize) {
        continue;
      }
      tiles.push({
        z,
        x: tileX,
        y: tileY,
        left: tileX * TILE_SIZE - x,
        top: tileY * TILE_SIZE - y,
      });
    }
  }
  return tiles;
}

/**
 * Whether a stored coordinate pair is a point that can be drawn.
 *
 * Takes the pair as one object so the type predicate narrows BOTH values: a
 * two-argument predicate can only narrow its first parameter, which would leave
 * the longitude still `number | null` at every call site that had just checked
 * it.
 */
export function isDrawablePoint(point: {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
}): point is { latitude: number; longitude: number } {
  const { latitude, longitude } = point;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}
