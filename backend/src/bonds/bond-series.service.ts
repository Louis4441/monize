import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "../common/db/locks";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { todayInTimezone } from "../common/date-utils";
import {
  describeFetchFailure,
  isTransportFailure,
} from "../common/http/fetch-failure.util";
import {
  FetchSyncJob,
  FetchSyncService,
} from "../common/jobs/fetch-sync.service";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { isProviderUnavailable } from "../provider-health/provider-unavailable.error";
import {
  BondAdapter,
  CatalogEntry,
  ManualSeriesValues,
  SeriesFetchError,
} from "./bond-adapter";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";
import { BondCatalogService } from "./bond-catalog.service";
import { bondInstrumentId } from "./bond-instrument-id";
import { BondInstrumentSummary } from "./bond-valuation.service";
import { BondTermsError, parseBondTerms } from "./domain/bond-terms";
import { HttpFetch, SeriesHttp } from "./series-http";

/** The catalog's answer to a series request: the instrument, and whether this call stored it. */
export interface BondSeriesResult extends BondInstrumentSummary {
  readonly created: boolean;
}

export interface SeriesRequestOptions {
  /** The network, injectable so a test never leaves the process. */
  readonly fetch?: HttpFetch;
  readonly adapters?: readonly BondAdapter[];
}

/** What one daily check of the current offer did, in series. */
export interface CurrentOfferRun {
  readonly listed: number;
  readonly stored: number;
  readonly alreadyStored: number;
  readonly failed: number;
}

/** What one pass of the history backfill did, in series. */
export interface BackfillRun {
  /** Every code the adapters offered to try. */
  readonly candidates: number;
  /** Already in the catalog, so not asked for. */
  readonly alreadyStored: number;
  readonly stored: number;
  /** Refused as `SERIES_NOT_PUBLISHED`: a product not sold that month. */
  readonly notPublished: number;
  readonly failed: number;
  /** An adapter's pass stopped on `SOURCE_UNAVAILABLE`; the next run resumes. */
  readonly stoppedEarly: boolean;
}

export interface BackfillOptions extends SeriesRequestOptions {
  /** Waits between two requests; injectable so a test does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The adapters' day, YYYY-MM-DD; their own timezone's today when omitted. */
  readonly today?: string;
}

/** The least time between two requests to the issuer's site by the backfill. */
export const BACKFILL_GAP_MS = 3000;

/**
 * The current-offer check (a page and a letter for each of a month's series)
 * and then the backfill of about 270 series: each is a gap of 3 s plus two
 * requests of a second or a few, so about half an hour; 90 minutes leaves room
 * for a slow source and is still far shorter than a day. A lease that ran out
 * mid-pass would let a second replica start one beside it, which only repeats
 * requests (every store is idempotent), so the figure is a cost control.
 */
const SERIES_LEASE_MS = 90 * 60 * 1000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gets a series that the catalog lacks from its market's official source, or
 * from an administrator's hand, into `bond_instruments` and `bond_terms_versions`
 * (INV-BOND-006). The service knows no country: the adapter owns the host, the
 * page and letter formats and the product templates, and names the provider the
 * request is gated under.
 *
 * Every check that can refuse runs before the transaction that writes
 * (`docs/specs/bond-series-fetch.md` section 2): the network read and the
 * adapter's parse happen first, and a refused read leaves no row. The write is
 * the catalog's own per-entry store, under an advisory lock keyed on the
 * instrument id, so two requests for one series insert once.
 */
@Injectable()
export class BondSeriesService {
  private readonly logger = new Logger(BondSeriesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: BondCatalogService,
    private readonly http: SeriesHttp,
    private readonly health: ProviderHealthService,
    private readonly fetchSync: FetchSyncService,
  ) {}

  /**
   * The series from the official source: the stored instrument when its first
   * terms version is already stored (nothing is fetched), else the adapter's
   * fetch, stored. Needs an ambient identity, like any database access.
   */
  async fetchSeries(
    countryCode: string,
    seriesCode: string,
    options: SeriesRequestOptions = {},
  ): Promise<BondSeriesResult> {
    const country = countryCode.toUpperCase();
    const series = seriesCode.trim().toUpperCase();
    const adapter = this.adapterFor(country, series, options.adapters);
    const fetchSeries = adapter.fetchSeries;
    const providerId = adapter.seriesProviderId;
    if (!fetchSeries || !providerId) throw this.unsupported(country, series);

    const stored = await withScopedDb(this.dataSource, (m) =>
      this.catalog.findStoredSeries(m, adapter.countryCode, series),
    );
    if (stored) return { ...stored, created: false };

    let entry: CatalogEntry;
    try {
      const fetched = await fetchSeries.call(
        adapter,
        series,
        this.http.gated(providerId, options.fetch),
      );
      entry = fetched.entry;
    } catch (error) {
      throw this.named(error, country, series);
    }
    return this.store(entry, country, series);
  }

  /**
   * An administrator's values on the adapter's template, stored like a fetched
   * series with `source.provider` `manual`. The caller has checked the role
   * (`isAdministrator`); the bounds and the strict parser are the adapter's.
   */
  async enterManually(
    countryCode: string,
    seriesCode: string,
    values: ManualSeriesValues,
    options: Pick<SeriesRequestOptions, "adapters"> = {},
  ): Promise<BondSeriesResult> {
    const country = countryCode.toUpperCase();
    const series = seriesCode.trim().toUpperCase();
    const adapter = this.adapterFor(country, series, options.adapters);
    if (!adapter.manualSeries) throw this.unsupported(country, series);
    let entry: CatalogEntry;
    try {
      entry = adapter.manualSeries(series, values);
    } catch (error) {
      throw this.named(error, country, series);
    }
    return this.store(entry, country, series);
  }

  /**
   * Runs an administrator's values through the adapter's bounds and strict
   * parser without storing anything, so a person is asked to confirm only a
   * series that would be accepted. Throws the same refusals as `enterManually`.
   */
  checkManual(
    countryCode: string,
    seriesCode: string,
    values: ManualSeriesValues,
    options: Pick<SeriesRequestOptions, "adapters"> = {},
  ): void {
    const country = countryCode.toUpperCase();
    const series = seriesCode.trim().toUpperCase();
    const adapter = this.adapterFor(country, series, options.adapters);
    if (!adapter.manualSeries) throw this.unsupported(country, series);
    try {
      adapter.manualSeries(series, values);
    } catch (error) {
      throw this.named(error, country, series);
    }
  }

  /**
   * Whether the user holds the administrator role, read from their row (the
   * MCP and the AI tools have no guard in front of them). Needs an ambient
   * identity for the user.
   */
  async isAdministrator(userId: string): Promise<boolean> {
    const rows: Array<{ role: string }> = await withScopedDb(
      this.dataSource,
      (m) => m.query(`SELECT role FROM users WHERE id = $1`, [userId]),
    );
    return rows[0]?.role === "admin";
  }

  /**
   * Daily, after the price recompute (06:45): a new month's series go on sale
   * on the first, and storing them without anyone asking means the picker finds
   * them; then the one-off history backfill (`backfillHistory`) fills what the
   * offer pass does not reach. Cross-user work with no request behind it, so it seeds its own system
   * context around the whole lease call; the lease is a cost control, because
   * the store is idempotent however many replicas run
   * (`docs/backend/cron-and-background-work.md`).
   */
  // The timezone is spelled as a literal: cron-doc.spec.ts reads it from the decorator.
  @Cron("15 7 * * *", { timeZone: "Europe/Warsaw" })
  async scheduledCurrentOffer(): Promise<void> {
    try {
      await withSystemContext(() =>
        this.fetchSync.withLease(
          FetchSyncJob.BondSeries,
          SERIES_LEASE_MS,
          async () => {
            // The backfill follows even when the offer failed, so the failure
            // still reaches the lease record, after the history had its turn.
            let offerFailure: unknown = null;
            try {
              await this.fetchCurrentOffer();
            } catch (error) {
              offerFailure = error;
            }
            await this.backfillHistory();
            if (offerFailure !== null) throw offerFailure;
          },
        ),
      );
    } catch (error) {
      // `withLease` has already recorded the failure in fetch_sync, and each
      // series logged its own cause; a cron must not die on it.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Scheduled bond series check failed: ${message}`);
    }
  }

  /**
   * Every series each adapter lists as on sale and the catalog lacks. A series
   * already stored is not fetched; one failing is logged and does not stop the
   * next. Throws at the end when everything attempted failed, so the lease
   * wrapper records a failure rather than a success. Needs an ambient identity
   * (`withSystemContext`).
   */
  async fetchCurrentOffer(
    options: SeriesRequestOptions = {},
  ): Promise<CurrentOfferRun> {
    let listed = 0;
    let stored = 0;
    let alreadyStored = 0;
    let failed = 0;
    for (const adapter of options.adapters ?? INSTALLED_BOND_ADAPTERS) {
      const providerId = adapter.seriesProviderId;
      if (!adapter.currentSeries || !adapter.fetchSeries || !providerId)
        continue;
      let codes: string[];
      try {
        codes = await adapter.currentSeries(
          this.http.gated(providerId, options.fetch),
        );
      } catch (error) {
        failed += 1;
        this.logRefusal(
          `current offer of ${adapter.countryCode}`,
          providerId,
          error,
        );
        continue;
      }
      listed += codes.length;
      for (const code of codes) {
        try {
          const result = await this.fetchSeries(adapter.countryCode, code, {
            ...options,
            adapters: [adapter],
          });
          if (result.created) stored += 1;
          else alreadyStored += 1;
        } catch (error) {
          failed += 1;
          this.logRefusal(
            `${adapter.countryCode} series ${code}`,
            providerId,
            error,
          );
        }
      }
    }
    this.logger.log(
      `Bond series check: ${listed} listed, ${stored} stored, ${alreadyStored} already stored, ${failed} failed`,
    );
    if (failed > 0 && stored + alreadyStored === 0) {
      throw new Error(
        `Every bond series check failed (${failed}); see the log for each cause`,
      );
    }
    return { listed, stored, alreadyStored, failed };
  }

  /**
   * The history backfill (`docs/specs/bond-offer-and-history.md` section 4):
   * every series code each adapter offers (`backfillCodes`) that the catalog
   * lacks, asked for one at a time with `BACKFILL_GAP_MS` before each request.
   * Only series that are not stored are asked for, so a rerun is idempotent and
   * a run that stopped resumes where it stopped. `SOURCE_UNAVAILABLE` ends that
   * adapter's pass (the source is down; the next daily run resumes); a series
   * the source does not publish, or any other refusal, is logged and the pass
   * goes on. Needs an ambient identity (`withSystemContext`).
   */
  async backfillHistory(options: BackfillOptions = {}): Promise<BackfillRun> {
    const sleep = options.sleep ?? defaultSleep;
    let candidates = 0;
    let alreadyStored = 0;
    let stored = 0;
    let notPublished = 0;
    let failed = 0;
    let stoppedEarly = false;
    for (const adapter of options.adapters ?? INSTALLED_BOND_ADAPTERS) {
      const providerId = adapter.seriesProviderId;
      if (!adapter.backfillCodes || !adapter.fetchSeries || !providerId)
        continue;
      const today =
        options.today ??
        todayInTimezone(adapter.timezone) ??
        (todayInTimezone("UTC") as string);
      const codes = adapter.backfillCodes(today);
      const held = await withScopedDb(this.dataSource, (m) =>
        this.catalog.storedSeriesCodes(m, adapter.countryCode, codes),
      );
      const missing = codes.filter((code) => !held.has(code.toUpperCase()));
      candidates += codes.length;
      alreadyStored += codes.length - missing.length;
      for (const code of missing) {
        // Before every request, the first included: the current-offer pass has
        // just spoken to the same host.
        await sleep(BACKFILL_GAP_MS);
        try {
          const result = await this.fetchSeries(adapter.countryCode, code, {
            ...options,
            adapters: [adapter],
          });
          if (result.created) stored += 1;
          else alreadyStored += 1;
        } catch (error) {
          this.logRefusal(
            `${adapter.countryCode} series ${code} (backfill)`,
            providerId,
            error,
          );
          const refusal = error instanceof SeriesFetchError ? error.code : null;
          if (refusal === "SOURCE_UNAVAILABLE") {
            failed += 1;
            stoppedEarly = true;
            break;
          }
          if (refusal === "SERIES_NOT_PUBLISHED") notPublished += 1;
          else failed += 1;
        }
      }
    }
    this.logger.log(
      `Bond series backfill: ${candidates} candidates, ${alreadyStored} already stored, ${stored} stored, ` +
        `${notPublished} not published, ${failed} failed${stoppedEarly ? ", stopped on an unavailable source" : ""}`,
    );
    return {
      candidates,
      alreadyStored,
      stored,
      notPublished,
      failed,
      stoppedEarly,
    };
  }

  /**
   * One transaction: the advisory lock on the instrument, then the catalog's
   * store, which re-reads inside the lock. The same content is "already
   * stored"; different content is refused and the transaction rolls back, so a
   * refused request leaves nothing (INV-BOND-001).
   */
  private async store(
    entry: CatalogEntry,
    country: string,
    series: string,
  ): Promise<BondSeriesResult> {
    let instrumentId: string;
    try {
      const { instrument } = parseBondTerms(entry.terms);
      instrumentId = bondInstrumentId(
        instrument.issuerCountryCode,
        instrument.issuerCode,
        instrument.seriesCode,
      );
    } catch (error) {
      if (error instanceof BondTermsError) {
        throw this.named(
          new SeriesFetchError(
            "SOURCE_FORMAT_CHANGED",
            { field: "terms" },
            { cause: error },
          ),
          country,
          series,
        );
      }
      throw error;
    }

    return withScopedDb(this.dataSource, async (m) => {
      await acquireAdvisoryLock(m, LockScope.BondSeriesFetch, instrumentId);
      const outcome = await this.catalog.storeEntry(m, entry);
      switch (outcome.kind) {
        case "invalid":
          throw this.named(
            new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "terms" }),
            country,
            series,
          );
        case "conflict":
        case "instrument-mismatch":
          this.logger.error(
            `Series ${outcome.named} is stored with different terms than the ones just read ` +
              `(${outcome.kind}); stored terms are immutable (INV-BOND-001), so nothing was written.`,
          );
          throw this.named(
            new SeriesFetchError("SERIES_TERMS_CONFLICT"),
            country,
            series,
          );
        case "inserted":
        case "unchanged": {
          const summary = await this.catalog.findSummary(
            m,
            outcome.instrumentId,
          );
          if (!summary) {
            // Unreachable inside the transaction that has just stored it.
            throw new Error(`Stored series ${outcome.named} cannot be read`);
          }
          if (outcome.kind === "inserted") {
            this.logger.log(`Stored terms version 1 of ${outcome.named}`);
          }
          return { ...summary, created: outcome.kind === "inserted" };
        }
      }
    });
  }

  private adapterFor(
    country: string,
    series: string,
    adapters: readonly BondAdapter[] = INSTALLED_BOND_ADAPTERS,
  ): BondAdapter {
    const adapter = adapters.find((a) => a.countryCode === country);
    if (!adapter) throw this.unsupported(country, series);
    return adapter;
  }

  private unsupported(country: string, series: string): SeriesFetchError {
    return new SeriesFetchError("SERIES_FETCH_UNSUPPORTED", {
      country,
      series,
    });
  }

  /**
   * An adapter's refusal, naming the request on its params (the message names
   * the series and the country, which the adapter does not know). Anything that
   * is not a series refusal passes through unchanged.
   */
  private named(error: unknown, country: string, series: string): unknown {
    if (!(error instanceof SeriesFetchError)) return error;
    return new SeriesFetchError(
      error.code,
      { country, series, ...error.params },
      { cause: error.cause },
    );
  }

  /** A refused series in the log: its code and params, and the transport cause when there is one. */
  private logRefusal(what: string, providerId: string, error: unknown): void {
    const cause = error instanceof SeriesFetchError ? error.cause : error;
    if (
      cause !== undefined &&
      (isProviderUnavailable(cause) || isTransportFailure(cause))
    ) {
      // Rate-limited and counted by the breaker; a refused call prints nothing.
      this.health.logFailure(this.logger, providerId, `bond ${what}`, cause);
      return;
    }
    const reason =
      error instanceof SeriesFetchError
        ? error.message
        : describeFetchFailure(error);
    this.logger.warn(`Bond series fetch for ${what} refused: ${reason}`);
  }
}
