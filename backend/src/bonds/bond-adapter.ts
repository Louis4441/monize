import { TrackedProviderId } from "../provider-health/providers";
import { CalendarRegistry } from "./domain/calendar-registry";

/** A benchmark series an adapter knows how to fetch and keep up to date. */
export interface BenchmarkSeriesDefinition {
  readonly code: string;
  readonly kind: "STEP" | "MONTHLY";
  readonly publisher: string;
  readonly sourceUrl: string;
  /** Values are stored as fractions: 0.0575 for 5.75 percent. */
  readonly unit: "RATE_FRACTION";
  /** The outbound provider the fetch is gated and reported under. */
  readonly providerId: TrackedProviderId;
}

/**
 * One curated terms document. A correction is a new `termsVersion`, never an
 * edit of an existing entry (INV-BOND-001).
 */
export interface CatalogEntry {
  readonly termsVersion: number;
  readonly publishedAt: string | null;
  /** The raw manifest JSON; the catalog service parses and validates it. */
  readonly terms: unknown;
}

export interface BenchmarkObservation {
  readonly observationDate: string;
  /** A fraction as an exact decimal string. */
  readonly value: string;
  readonly publishedOn: string | null;
  /**
   * The document this observation was read from, when it differs from the
   * result's `sourceUrl` (a feed assembled from more than one file).
   */
  readonly sourceUrl?: string;
}

export interface BenchmarkFetchResult {
  readonly observations: readonly BenchmarkObservation[];
  /** The source is authoritative for every day up to and including this date. */
  readonly coveredThrough: string;
  readonly sourceUrl: string;
}

/**
 * The only door the adapters have to the network. The caller gates it behind the
 * provider's circuit breaker and reads the whole body, so an adapter is a pure
 * function of what comes back and a test needs no socket.
 */
export type BondFetch = (url: string) => Promise<{
  status: number;
  body: Uint8Array;
  /**
   * The URL the body came from after any redirect, when the caller knows it. An
   * adapter that fetches only from its publisher's host refuses a different one.
   */
  url?: string;
}>;

export class BenchmarkFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkFetchError";
  }
}

/** Where a piece of fetched terms came from (provider, document URL, fetch time). */
export interface SourceRef {
  readonly provider: string;
  readonly url: string;
  /** ISO-8601 instant the document was read. */
  readonly retrievedAt: string;
}

/** A series read from its official source, ready to go through the catalog. */
export interface FetchedSeries {
  readonly entry: CatalogEntry;
  readonly sources: readonly SourceRef[];
}

/**
 * The per-series values an administrator types when the official source cannot
 * be read: everything else comes from the adapter's product template. Decimals
 * are strings (a rate as a fraction, a fee as an amount), dates are YYYY-MM-DD.
 * `addend` is the margin or spread, absent for a fixed-rate product; `fee` is the
 * early redemption fee, absent for a product that charges none.
 */
export interface ManualSeriesValues {
  readonly firstPeriodRate: string;
  readonly addend: string | null;
  readonly fee: string | null;
  readonly saleWindow: { readonly from: string; readonly to: string };
  readonly letter: { readonly number: string; readonly date: string };
}

export type SeriesFetchErrorCode =
  | "SERIES_CODE_INVALID"
  | "SERIES_NOT_PUBLISHED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_FORMAT_CHANGED"
  | "SOURCE_INCONSISTENT"
  | "TEMPLATE_NOT_VALIDATED";

/**
 * A refused series fetch or manual entry. `params` carries short machine values
 * (a field name, two compared values) for the translated message; it never holds
 * free text from the source.
 */
export class SeriesFetchError extends Error {
  constructor(
    readonly code: SeriesFetchErrorCode,
    readonly params: Readonly<Record<string, string>> = {},
    options?: { readonly cause?: unknown },
  ) {
    super(
      `${code} ${Object.entries(params)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")}`.trim(),
      options,
    );
    this.name = "SeriesFetchError";
  }
}

/** Everything one country contributes: calendars, benchmarks, curated terms. */
export interface BondAdapter {
  readonly countryCode: string;
  /**
   * IANA zone of the market's publishers. The adapter's own calendar day decides
   * whether one of its series is fresh (`BenchmarkRefreshService`).
   */
  readonly timezone: string;
  registerCalendars(registry: CalendarRegistry): CalendarRegistry;
  readonly benchmarks: readonly BenchmarkSeriesDefinition[];
  readonly catalog: readonly CatalogEntry[];
  fetchBenchmark(code: string, fetch: BondFetch): Promise<BenchmarkFetchResult>;
  /**
   * Reads one series' terms from the market's official source. Absent when the
   * adapter cannot; the caller then refuses the request.
   */
  fetchSeries?(seriesCode: string, fetch: BondFetch): Promise<FetchedSeries>;
  /** The same entry built from an administrator's values on the same template. */
  manualSeries?(seriesCode: string, values: ManualSeriesValues): CatalogEntry;
}
