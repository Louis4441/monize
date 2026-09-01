import { Injectable, Logger } from "@nestjs/common";
import { describeFetchFailure } from "../http/fetch-failure.util";
import { resolvePositiveInt } from "../env-number.util";
import { OSM_USER_AGENT } from "./osm-user-agent";
import { GeocodeResult } from "./geocode.columns";

/** Default geocoder. Overridden with `NOMINATIM_URL` for a self-hosted one. */
const DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/**
 * Resolves a free-text postal address to a point, server-side, so the browser
 * never contacts a geocoder itself -- the same reason brand favicons are
 * fetched by the backend rather than linked.
 *
 * Every failure returns null: a geocode is decoration on a payee, and a
 * geocoder being slow or down must never fail the save that triggered it.
 *
 * ## Staying inside Nominatim's usage policy
 *
 * The public instance allows **one request per second** and forbids bulk
 * geocoding outright. Two mechanisms hold that here, and both live in this
 * service rather than in its callers, because a limit each caller has to
 * remember is a limit the next caller breaks:
 *
 *  - **A serialized queue.** Every lookup goes through one promise chain that
 *    waits out `MIN_INTERVAL_MS` since the previous outbound request. Concurrent
 *    callers queue rather than burst, so no code path can exceed the rate no
 *    matter how it is driven -- the bulk AI/MCP payee path loops rows with no
 *    delay of its own, and it is the reason this is not merely advisory.
 *  - **A result cache.** The same address is answered from memory for
 *    `CACHE_TTL_MS`, so re-running a bulk action, or saving a payee twice,
 *    costs no request at all.
 *
 * The caller's own value-difference guard (an unchanged address is never
 * re-geocoded) removes most requests before they reach either.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  private static readonly TIMEOUT_MS = 6000;
  /** Nominatim's published rate limit is 1 req/s; this is that limit. */
  private static readonly MIN_INTERVAL_MS = 1000;
  private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly CACHE_MAX_ENTRIES = 200;
  /** A geocoder answers a line of text; anything longer is not an address. */
  private static readonly MAX_QUERY_LENGTH = 500;

  /**
   * The tail of the request chain. Each lookup appends itself, so requests run
   * one at a time in submission order. A rejected link is neutralised before it
   * becomes the next link's predecessor, otherwise one failure would reject
   * every later lookup in the chain.
   */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  /**
   * Insertion-ordered so the oldest entry is the first key -- which is what
   * makes eviction below a plain `keys().next()` rather than a scan. A hit
   * re-inserts to move the entry to the end.
   */
  private readonly cache = new Map<
    string,
    { result: GeocodeResult | null; expiresAt: number }
  >();

  /**
   * Collapse an address to the single line a geocoder queries with. Newlines
   * and runs of whitespace become one space: a multi-line address is the same
   * query as its one-line form, and the cache should treat them as one.
   */
  static normalizeQuery(address: string): string {
    return address.replace(/\s+/g, " ").trim();
  }

  /**
   * Look up an address. Returns null when the address is empty, when the
   * geocoder finds nothing, and on every failure -- callers cannot tell those
   * apart on purpose, because all three mean "no point to show" and the caller
   * stamps the attempt either way.
   */
  async geocode(address: string): Promise<GeocodeResult | null> {
    const query = GeocodingService.normalizeQuery(address);
    if (!query || query.length > GeocodingService.MAX_QUERY_LENGTH) return null;

    const key = query.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      // Re-insert so the most recently used entry is last, and the first key
      // stays the least recently used one for eviction.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.result;
    }
    if (cached) this.cache.delete(key);

    const result = await this.enqueue(() => this.request(query));
    this.remember(key, result);
    return result;
  }

  /** Run `fn` after every previously queued lookup, respecting the rate limit. */
  private async enqueue(
    fn: () => Promise<GeocodeResult | null>,
  ): Promise<GeocodeResult | null> {
    const run = this.queue.then(async () => {
      const sinceLast = Date.now() - this.lastRequestAt;
      const wait = GeocodingService.MIN_INTERVAL_MS - sinceLast;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
      return fn();
    });
    // The chain must survive a failed link: swallow here, not at the caller.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private remember(key: string, result: GeocodeResult | null): void {
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + GeocodingService.CACHE_TTL_MS,
    });
    while (this.cache.size > GeocodingService.CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /** The outbound request. Never throws. */
  private async request(query: string): Promise<GeocodeResult | null> {
    const base = process.env.NOMINATIM_URL || DEFAULT_NOMINATIM_URL;
    const url = `${base}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      GeocodingService.TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        // Nominatim answers an unidentified client with 403.
        headers: { "User-Agent": OSM_USER_AGENT, Accept: "application/json" },
      });

      if (!response.ok) {
        this.logger.warn(`Geocode returned HTTP ${response.status}`);
        return null;
      }

      const body: unknown = await response.json();
      if (!Array.isArray(body) || body.length === 0) return null;

      const first = body[0] as { lat?: unknown; lon?: unknown };
      return GeocodingService.toResult(first.lat, first.lon);
    } catch (error) {
      this.logger.warn(`Geocode failed: ${describeFetchFailure(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Coerce a geocoder's `lat`/`lon` (strings, in Nominatim's case) to a point,
   * rejecting anything not a real coordinate. A NaN or an out-of-range value
   * stored would put a marker somewhere the address is not, which is worse than
   * showing no map at all.
   */
  private static toResult(lat: unknown, lon: unknown): GeocodeResult | null {
    if (typeof lat !== "string" && typeof lat !== "number") return null;
    if (typeof lon !== "string" && typeof lon !== "number") return null;
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
  }
}

/**
 * How many addresses one bulk action may geocode. Beyond it the remaining rows
 * are saved un-geocoded (`geocodedAt` null, so the UI offers the retry that
 * exists for exactly this) rather than issuing hundreds of sequential requests
 * against a service whose policy forbids bulk geocoding.
 */
export function geocodeBulkLimit(): number {
  const { value, invalid } = resolvePositiveInt(
    process.env.GEOCODE_BULK_LIMIT,
    25,
  );
  if (invalid) {
    new Logger(GeocodingService.name).warn(
      `GEOCODE_BULK_LIMIT is not a positive integer; using ${value}`,
    );
  }
  return value;
}
