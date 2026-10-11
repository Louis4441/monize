import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { addDaysYMD, todayInTimezone } from "../common/date-utils";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
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
import { TrackedProviderId } from "../provider-health/providers";
import {
  BenchmarkFetchResult,
  BenchmarkSeriesDefinition,
  BondAdapter,
  BondFetch,
} from "./bond-adapter";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";
import { BondCatalogService } from "./bond-catalog.service";

export type HttpFetch = typeof globalThis.fetch;

export interface RefreshOptions {
  /**
   * Skip a series whose last successful fetch was today or yesterday in its adapter's timezone
   * (the boot warm-up). Freshness is when the series was last fetched
   * (`benchmark_series.updated_at`, stamped only by a successful store), never
   * `covered_through`: a MONTHLY series is covered only through its newest
   * reference month, which is always weeks behind a fetch made today.
   */
  readonly onlyStale?: boolean;
  /** The network, injectable so a test never leaves the process. */
  readonly fetch?: HttpFetch;
  readonly adapters?: readonly BondAdapter[];
}

const FETCH_TIMEOUT_MS = 30_000;
/** Days without a successful store after which a failing series is reported as an outage. */
const PERSISTENT_FAILURE_DAYS = 3;

/**
 * Keeps the benchmark series (NBP reference rate, GUS CPI, whatever an adapter
 * declares) current. Global reference data, so one fetch serves every user.
 *
 * Cost control, not correctness: the upserts converge however many replicas run,
 * so the lease (`bond-benchmarks`) only stops N replicas asking the same
 * publisher at the same instant.
 */
@Injectable()
export class BenchmarkRefreshService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BenchmarkRefreshService.name);

  /** Longer than a refresh of two small files, far shorter than a day. */
  private readonly FETCH_LEASE_MS = 10 * 60 * 1000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly health: ProviderHealthService,
    private readonly fetchSync: FetchSyncService,
    private readonly catalog: BondCatalogService,
  ) {}

  /**
   * Warm up a deployment whose series are empty or stale, under the same lease
   * as the cron so a rollout of N pods fetches once. A failure is a warning, not
   * a reason to stop the application.
   */
  onApplicationBootstrap(): void {
    void withSystemContext(() =>
      this.fetchSync.withLease(
        FetchSyncJob.BondBenchmarks,
        this.FETCH_LEASE_MS,
        () => this.refreshAll({ onlyStale: true }),
      ),
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Initial bond benchmark refresh failed: ${message}`);
    });
  }

  /**
   * The trigger time is shared; each adapter's own day decides freshness.
   * Weekday morning in Warsaw: GUS publishes mid-month and NBP announces after
   * its policy meetings, both during the working day before.
   *
   * Cross-user work with no request behind it, so it seeds its own system
   * context (`docs/backend/cron-and-background-work.md`); the wrapper goes
   * around the whole lease call.
   */
  @Cron("25 6 * * 1-5", { timeZone: "Europe/Warsaw" })
  async scheduledRefresh(): Promise<void> {
    try {
      await withSystemContext(() =>
        this.fetchSync.withLease(
          FetchSyncJob.BondBenchmarks,
          this.FETCH_LEASE_MS,
          () => this.refreshAll(),
        ),
      );
    } catch (error) {
      // `withLease` has already recorded the failure in fetch_sync, and each
      // series logged its own cause; a cron must not die on it.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Scheduled bond benchmark refresh failed: ${message}`);
    }
  }

  /**
   * Refresh every declared series. One series failing is logged and does not
   * stop the next; when every series that was attempted failed the run throws at
   * the end, so the lease wrapper records it in `fetch_sync` as a failure rather
   * than a success. Needs an ambient identity (`withSystemContext`).
   */
  async refreshAll(options: RefreshOptions = {}): Promise<void> {
    const adapters = options.adapters ?? INSTALLED_BOND_ADAPTERS;
    const http: HttpFetch | undefined = options.fetch;
    // The series rows must exist before a value can reference one, whichever
    // service booted first.
    await this.catalog.seedBenchmarkSeries(adapters);

    let attempted = 0;
    let failed = 0;
    for (const adapter of adapters) {
      // Each adapter's own calendar day decides freshness and the outage window.
      const today = todayInTimezone(adapter.timezone) as string;
      for (const series of adapter.benchmarks) {
        const outcome = await this.refreshSeries(
          adapter,
          series,
          http,
          today,
          options.onlyStale === true,
        );
        if (outcome !== "skipped") attempted += 1;
        if (outcome === "failed") failed += 1;
      }
    }
    if (attempted > 0 && failed === attempted) {
      throw new Error(
        `Every bond benchmark series failed to refresh (${failed} of ${attempted}); see the log for each cause`,
      );
    }
  }

  private async refreshSeries(
    adapter: BondAdapter,
    series: BenchmarkSeriesDefinition,
    http: HttpFetch | undefined,
    today: string,
    onlyStale: boolean,
  ): Promise<"stored" | "skipped" | "failed"> {
    try {
      if (
        onlyStale &&
        !(await this.isStale(series.code, today, adapter.timezone))
      )
        return "skipped";
      const result = await adapter.fetchBenchmark(
        series.code,
        this.gated(series.providerId, http),
      );
      await this.store(series.code, result);
      this.health.recordDataRecovered(series.providerId);
      this.logger.log(
        `Stored ${result.observations.length} observation(s) for ${series.code}, covered through ${result.coveredThrough}`,
      );
      return "stored";
    } catch (error) {
      if (isProviderUnavailable(error) || isTransportFailure(error)) {
        // Rate-limited and counted by the breaker; a refused call prints nothing.
        this.health.logFailure(
          this.logger,
          series.providerId,
          `bond benchmark refresh for ${series.code}`,
          error,
        );
      } else {
        this.logger.error(
          `Bond benchmark refresh for ${series.code} failed: ${describeFetchFailure(error)}`,
        );
      }
      await this.reportPersistentFailure(
        series,
        today,
        adapter.timezone,
        error,
      );
      return "failed";
    }
  }

  /**
   * A run is refreshed once a day, so the breaker (five transport failures in
   * five minutes) never opens on it, and a stale or reformatted file is not a
   * transport failure at all. A series that has not been stored for
   * `PERSISTENT_FAILURE_DAYS` is therefore reported to `ProviderHealthService`
   * itself, which is what the outage alert sweep reads. Never throws: reporting
   * must not turn one failed series into a failed run.
   */
  private async reportPersistentFailure(
    series: BenchmarkSeriesDefinition,
    today: string,
    timezone: string,
    error: unknown,
  ): Promise<void> {
    try {
      const fetchedOn = await this.lastFetchedOn(series.code, timezone);
      if (
        fetchedOn === null ||
        fetchedOn < addDaysYMD(today, -PERSISTENT_FAILURE_DAYS)
      ) {
        this.health.recordDataFailure(
          series.providerId,
          `${series.code}: ${describeFetchFailure(error)}` +
            (fetchedOn === null
              ? " (never stored)"
              : ` (last stored ${fetchedOn})`),
        );
      }
    } catch (reportError) {
      this.logger.warn(
        `Could not report the failure of ${series.code}: ${describeFetchFailure(reportError)}`,
      );
    }
  }

  /**
   * Never fetched (no coverage yet), or last fetched before yesterday in the adapter's timezone.
   * `updated_at` is the last successful store; the catalog seed does not touch it.
   */
  private async isStale(
    code: string,
    today: string,
    timezone: string,
  ): Promise<boolean> {
    const fetchedOn = await this.lastFetchedOn(code, timezone);
    return fetchedOn === null || fetchedOn < addDaysYMD(today, -1);
  }

  /** The date, in `timezone`, of the last successful store, or null when never fetched. */
  private async lastFetchedOn(
    code: string,
    timezone: string,
  ): Promise<string | null> {
    const rows: Array<{ fetched_on: string | null }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT CASE WHEN covered_through IS NULL THEN NULL
                       ELSE TO_CHAR(updated_at AT TIME ZONE $2, 'YYYY-MM-DD') END AS fetched_on
             FROM benchmark_series WHERE code = $1`,
          [code, timezone],
        ),
    );
    return rows[0]?.fetched_on ?? null;
  }

  /**
   * The network, behind the provider's circuit breaker: a refusal throws before
   * any socket is opened, a transport failure is counted, and success is
   * recorded only once the whole body has arrived.
   */
  private gated(
    providerId: TrackedProviderId,
    http: HttpFetch | undefined,
  ): BondFetch {
    return async (url) => {
      const admission = this.health.assertAvailable(providerId);
      let status: number;
      let body: Uint8Array;
      try {
        const init = { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
        // A test injects `http`; production calls the global fetch here, in the
        // one place provider-call.guard.spec.ts scans for its breaker.
        const response = http ? await http(url, init) : await fetch(url, init);
        status = response.status;
        body = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        const counted = this.health.recordFailure(providerId, error);
        if (!counted && admission === "probe")
          this.health.releaseProbe(providerId);
        throw error;
      }
      this.health.recordSuccess(providerId);
      return { status, body };
    };
  }

  /**
   * One transaction: the observations, then the coverage. A value is rewritten
   * only when it differs (a publisher's revision corrects a row), and
   * `covered_through` only moves forward. Each row cites its own document when
   * the observation names one, else the result's. `updated_at` is stamped here
   * only: it is the series' last successful fetch (see `isStale`).
   */
  private async store(
    code: string,
    result: BenchmarkFetchResult,
  ): Promise<void> {
    const { observations } = result;
    await withScopedDb(this.dataSource, async (m) => {
      if (observations.length > 0) {
        // `old` reads the rows as they were before this statement's upsert (a
        // data-modifying CTE shares the statement snapshot), so a correction
        // reports the value it replaced. A newly inserted row has no old side.
        const corrections: Array<{
          observation_date: string;
          old_value: string;
          new_value: string;
        }> = await m.query(
          `WITH incoming AS (
             SELECT t.d, t.v, t.p, COALESCE(t.u, $5::text) AS u
               FROM unnest($2::date[], $3::numeric[], $4::date[], $6::text[]) AS t(d, v, p, u)
           ), old AS (
             SELECT bv.observation_date, bv.value
               FROM benchmark_values bv
               JOIN incoming i ON i.d = bv.observation_date
              WHERE bv.benchmark_code = $1::varchar
           ), upserted AS (
             INSERT INTO benchmark_values
               (benchmark_code, observation_date, value, published_on, source_url, retrieved_at)
             SELECT $1::varchar, i.d, i.v, i.p, i.u, NOW() FROM incoming i
             ON CONFLICT (benchmark_code, observation_date) DO UPDATE
                SET value = EXCLUDED.value,
                    published_on = EXCLUDED.published_on,
                    source_url = EXCLUDED.source_url,
                    retrieved_at = EXCLUDED.retrieved_at
              WHERE benchmark_values.value IS DISTINCT FROM EXCLUDED.value
             RETURNING observation_date, value
           )
           SELECT TO_CHAR(u.observation_date, 'YYYY-MM-DD') AS observation_date,
                  o.value::text AS old_value,
                  u.value::text AS new_value
             FROM upserted u
             JOIN old o ON o.observation_date = u.observation_date`,
          [
            code,
            observations.map((o) => o.observationDate),
            observations.map((o) => o.value),
            observations.map((o) => o.publishedOn),
            result.sourceUrl,
            observations.map((o) => o.sourceUrl ?? null),
          ],
        );
        for (const c of corrections ?? []) {
          this.logger.warn(
            `Bond benchmark correction: series ${code}, observation ${c.observation_date}, value ${c.old_value} replaced by ${c.new_value}`,
          );
        }
      }
      await m.query(
        `UPDATE benchmark_series
            SET covered_through = GREATEST(COALESCE(covered_through, $2::date), $2::date),
                updated_at = NOW()
          WHERE code = $1`,
        [code, result.coveredThrough],
      );
    });
  }
}
