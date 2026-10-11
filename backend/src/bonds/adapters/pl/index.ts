import { todayInTimezone } from "../../../common/date-utils";
import {
  BenchmarkFetchError,
  BondAdapter,
  BondFetch,
  CatalogEntry,
} from "../../bond-adapter";
import { registerCalendar } from "../../domain/calendar-registry";
import type { CalendarRegistry } from "../../domain/calendar-registry";
import coi from "./manifests/coi1030.terms.json";
import edo from "./manifests/edo1036.terms.json";
import ror from "./manifests/ror1027.terms.json";
import tos from "./manifests/tos1029.terms.json";
import ots from "./manifests/ots0127.terms.json";
import dor from "./manifests/dor1028.terms.json";
import ros from "./manifests/ros1032.terms.json";
import rod from "./manifests/rod1038.terms.json";
import { fetchGusCpi, GUS_CPI_LANDING_URL } from "./pl-gus-cpi";
import { fetchNbpReference, NBP_ARCHIVE_URL } from "./pl-nbp-reference";
import { PL_CPI_GUS_YOY, PL_NBP_REFERENCE } from "./pl-benchmarks";
import { plCalendar } from "./pl-calendar";
import { backfillCodes, SERIES_VALID_FROM } from "./series/backfill-codes";
import { fetchCurrentSeries } from "./series/current-offer";
import { fetchSeries } from "./series/fetch-series";
import { manualSeries } from "./series/manual-series";

export { plBenchmarks } from "./pl-benchmarks";
export { plCalendar } from "./pl-calendar";

const PL_TIMEZONE = "Europe/Warsaw";

/** The registry plus the Polish calendar, for the caller to pass to the engine. */
export function registerPolishCalendars(
  registry: CalendarRegistry,
): CalendarRegistry {
  return registerCalendar(registry, plCalendar);
}

/**
 * Each series carries the date of its own issue letter. Adding a series is one
 * import plus one entry here.
 */
const catalog: readonly CatalogEntry[] = [
  { terms: ots, publishedAt: "2026-09-21" },
  { terms: tos, publishedAt: "2026-09-21" },
  { terms: ror, publishedAt: "2026-09-21" },
  { terms: dor, publishedAt: "2026-09-21" },
  { terms: coi, publishedAt: "2026-09-21" },
  { terms: edo, publishedAt: "2026-09-21" },
  { terms: ros, publishedAt: "2026-09-21" },
  { terms: rod, publishedAt: "2026-09-21" },
].map(({ terms, publishedAt }) => ({ termsVersion: 1, publishedAt, terms }));

export const POLISH_BOND_ADAPTER: BondAdapter = {
  countryCode: "PL",
  timezone: PL_TIMEZONE,
  registerCalendars: registerPolishCalendars,
  benchmarks: [
    {
      code: PL_NBP_REFERENCE,
      kind: "STEP",
      publisher: "NBP",
      sourceUrl: NBP_ARCHIVE_URL,
      unit: "RATE_FRACTION",
      providerId: "nbp",
    },
    {
      code: PL_CPI_GUS_YOY,
      kind: "MONTHLY",
      publisher: "GUS",
      sourceUrl: GUS_CPI_LANDING_URL,
      unit: "RATE_FRACTION",
      providerId: "gus",
    },
  ],
  catalog,
  fetchSeries: (seriesCode: string, fetch: BondFetch) =>
    fetchSeries(seriesCode, fetch),
  manualSeries,
  seriesProviderId: "obligacjeskarbowe",
  currentSeries: fetchCurrentSeries,
  backfillCodes,
  seriesValidFrom: SERIES_VALID_FROM,
  async fetchBenchmark(code: string, fetch: BondFetch) {
    switch (code) {
      case PL_NBP_REFERENCE:
        return fetchNbpReference(fetch, todayInTimezone(PL_TIMEZONE) as string);
      case PL_CPI_GUS_YOY:
        return fetchGusCpi(fetch, todayInTimezone(PL_TIMEZONE) as string);
      default:
        throw new BenchmarkFetchError(
          `The Polish adapter has no benchmark ${code}`,
        );
    }
  },
};
