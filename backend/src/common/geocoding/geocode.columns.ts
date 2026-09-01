/**
 * The three columns a payee carries to remember where its address is.
 *
 * `latitude`/`longitude` are the resolved point, looked up server-side so the
 * browser never contacts a geocoder itself. `geocodedAt` stamps the last
 * *attempt*, successful or not -- exactly as `logoFetchedAt` does for a brand
 * icon -- which is what separates the three states a reader has to tell apart:
 *
 *   geocodedAt null                     -> never looked up (no address, or cleared)
 *   geocodedAt set, latitude null       -> looked up, nothing found
 *   latitude set                        -> located
 *
 * Without the timestamp the first two collapse into "no coordinates", and the
 * UI cannot tell a lookup that has not happened from one that failed -- so it
 * cannot know whether offering a retry would do anything.
 */
export interface GeocodeColumns {
  latitude: number | null;
  longitude: number | null;
  geocodedAt: Date | null;
}

/** A point a geocoder resolved an address to. */
export interface GeocodeResult {
  latitude: number;
  longitude: number;
}

/**
 * The column values for a lookup result. A failed lookup (`null`) clears any
 * previously stored point rather than leaving stale coordinates beside an
 * address that no longer resolves -- so the map can never show a location the
 * current address does not have -- and still stamps the attempt.
 */
export function geocodeColumns(result: GeocodeResult | null): GeocodeColumns {
  return result
    ? {
        latitude: result.latitude,
        longitude: result.longitude,
        geocodedAt: new Date(),
      }
    : { latitude: null, longitude: null, geocodedAt: new Date() };
}

/**
 * The column values for an address that has been removed. Distinct from a
 * failed lookup: nothing was attempted, so the timestamp is cleared too and the
 * UI offers no retry for an address that is not there.
 */
export const CLEARED_GEOCODE_COLUMNS: GeocodeColumns = {
  latitude: null,
  longitude: null,
  geocodedAt: null,
};
