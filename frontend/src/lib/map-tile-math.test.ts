import { describe, expect, it } from 'vitest';
import {
  globalPixel,
  isDrawablePoint,
  MAP_TILE_ZOOM,
  TILE_SIZE,
  tilesAround,
} from './map-tile-math';

describe('globalPixel', () => {
  it('puts null island at the exact centre of the world grid', () => {
    // At zoom z the world is 2^z tiles across, so (0,0) sits at half of that.
    const { x, y } = globalPixel(0, 0, 16);
    const half = (2 ** 16 * TILE_SIZE) / 2;

    expect(x).toBeCloseTo(half, 6);
    expect(y).toBeCloseTo(half, 6);
  });

  it('places a known coordinate on its documented tile', () => {
    // Pike Place Market, Seattle. The tile numbers are the values the OSM
    // slippy-map formula yields at z16 -- a fixed point that would move if the
    // projection were wrong.
    const { x, y } = globalPixel(47.609722, -122.342201, 16);

    expect(Math.floor(x / TILE_SIZE)).toBe(10496);
    expect(Math.floor(y / TILE_SIZE)).toBe(22887);
  });

  it('increases x eastward and y southward', () => {
    const west = globalPixel(0, -10, 10);
    const east = globalPixel(0, 10, 10);
    const north = globalPixel(10, 0, 10);
    const south = globalPixel(-10, 0, 10);

    expect(east.x).toBeGreaterThan(west.x);
    expect(south.y).toBeGreaterThan(north.y);
  });

  it('clamps a latitude Mercator cannot project rather than returning infinity', () => {
    // tan(90 degrees) is unbounded, so an unclamped projection returns
    // Infinity here and every tile built from it is NaN.
    const { y } = globalPixel(90, 0, 10);

    expect(Number.isFinite(y)).toBe(true);
    // Lands at the top edge of the world, within a pixel of it.
    expect(Math.abs(y)).toBeLessThan(1);
  });
});

describe('tilesAround', () => {
  it('returns a 3x3 block centred on the point', () => {
    const tiles = tilesAround(47.609722, -122.342201, 16);

    expect(tiles).toHaveLength(9);
    expect(new Set(tiles.map((t) => t.x))).toEqual(
      new Set([10495, 10496, 10497]),
    );
    expect(new Set(tiles.map((t) => t.y))).toEqual(
      new Set([22886, 22887, 22888]),
    );
  });

  it('positions tiles so the point itself lands at the origin', () => {
    // Each tile is placed at its own offset from the marker, so a tile
    // covering the point straddles (0,0) and the marker needs no extra maths.
    const tiles = tilesAround(47.609722, -122.342201, 16);
    const covering = tiles.filter(
      (t) =>
        t.left <= 0 && t.left + TILE_SIZE > 0 && t.top <= 0 && t.top + TILE_SIZE > 0,
    );

    expect(covering).toHaveLength(1);
  });

  it('covers at least a full tile in every direction from the point', () => {
    const tiles = tilesAround(47.609722, -122.342201, 16);
    const left = Math.min(...tiles.map((t) => t.left));
    const right = Math.max(...tiles.map((t) => t.left + TILE_SIZE));

    expect(left).toBeLessThanOrEqual(-TILE_SIZE);
    expect(right).toBeGreaterThanOrEqual(TILE_SIZE);
  });

  it('drops tiles outside the world grid instead of requesting them', () => {
    // At zoom 0 the world is a single tile, so eight of the nine do not exist.
    expect(tilesAround(0, 0, 0)).toHaveLength(1);
  });

  it('defaults to the fixed payee-map zoom', () => {
    expect(tilesAround(47.6, -122.3).every((t) => t.z === MAP_TILE_ZOOM)).toBe(
      true,
    );
  });
});

describe('isDrawablePoint', () => {
  it('accepts a real coordinate pair', () => {
    expect(isDrawablePoint({ latitude: 47.6, longitude: -122.3 })).toBe(true);
    expect(isDrawablePoint({ latitude: 0, longitude: 0 })).toBe(true);
  });

  it.each([
    ['a null latitude', null, -122.3],
    ['a null longitude', 47.6, null],
    ['both missing', null, null],
    ['an undefined value', undefined, undefined],
    ['a NaN', Number.NaN, 0],
    ['an out-of-range latitude', 91, 0],
    ['an out-of-range longitude', 0, 181],
  ])('rejects %s', (_label, lat, lng) => {
    expect(
      isDrawablePoint({
        latitude: lat as number | null,
        longitude: lng as number | null,
      }),
    ).toBe(false);
  });
});
