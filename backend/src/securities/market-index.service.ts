import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { todayYMD } from "../common/date-utils";
import {
  PRICE_WINDOW_LEAD_DAYS,
  withLeadDays,
} from "../common/time-series/price-boundary.util";
import {
  LoadedPriceSeries,
  PriceSampling,
  loadPriceSeries,
} from "../common/time-series/price-series.util";
import { YahooFinanceService } from "./yahoo-finance.service";
import {
  MARKET_INDEXES,
  MarketIndexDefinition,
  marketIndexByCode,
} from "./market-indexes";

/** Where an index's stored history begins and ends. */
export interface MarketIndexCoverage {
  earliestDate: string | null;
  latestDate: string | null;
}

/** A catalog entry with what we actually hold for it. */
export interface MarketIndexView extends MarketIndexDefinition {
  coverage: MarketIndexCoverage;
}

/**
 * How long after an attempt the same index may be fetched again.
 *
 * An index the provider cannot serve leaves no rows, so "do we have history back
 * to the window start" stays false and the on-demand backfill would fire on
 * every chart render. Six hours matches the per-security backfill cooldown in
 * `GemBackfillService`.
 */
export const INDEX_FETCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * How stale the newest stored close may be before the on-demand path tops the
 * series up rather than waiting for the next scheduled refresh. Generous enough
 * to span a long weekend, so an ordinary Monday morning does not fetch.
 */
const TOP_UP_AFTER_DAYS = 5;

/**
 * How far after a requested window start an index's stored history may begin and
 * still count as covering it. One trading week: shorter and a bank holiday at
 * the window edge triggers a pointless refetch.
 */
const COVERAGE_TOLERANCE_DAYS = 7;

/** Days of recent history the scheduled refresh re-requests. */
const REFRESH_WINDOW_DAYS = 10;

const SOURCE = "yahoo_finance";

interface UpsertRow {
  indexCode: string;
  priceDate: string;
  closePrice: number;
  adjustedClose: number | null;
}

/**
 * Daily closes for the curated market indexes.
 *
 * Indexes are global reference data, so everything here is deployment-wide: one
 * fetch per index serves every user, and the rows carry no owner. That is the
 * whole reason the catalog is not modelled as user-owned `securities` rows --
 * see `market-indexes.ts` and the exemption note in `database/schema.sql`.
 */
@Injectable()
export class MarketIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MarketIndexService.name);

  constructor(
    private dataSource: DataSource,
    private yahooFinanceService: YahooFinanceService,
  ) {}

  /**
   * The catalog with the stored coverage per index, so the picker can grey out
   * an index we cannot yet draw instead of offering it and rendering nothing.
   *
   * An index with no rows gets `{ earliestDate: null, latestDate: null }`, which
   * is "we hold nothing" -- distinct from a coverage window that happens to be
   * short.
   */
  async listCatalog(): Promise<MarketIndexView[]> {
    const rows: Array<{
      index_code: string;
      earliest: string | null;
      latest: string | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT index_code,
                MIN(price_date)::text AS earliest,
                MAX(price_date)::text AS latest
           FROM market_index_prices
          GROUP BY index_code`,
      ),
    );
    const byCode = new Map(rows.map((row) => [row.index_code, row]));
    return MARKET_INDEXES.map((index) => {
      const row = byCode.get(index.code);
      return {
        ...index,
        coverage: {
          earliestDate: row?.earliest ?? null,
          latestDate: row?.latest ?? null,
        },
      };
    });
  }

  /**
   * Close prices per index code, through the same door and with the same
   * per-series basis rule as a security's prices.
   */
  async loadSeries(
    codes: readonly string[],
    fromDate: string,
    toDate?: string,
    sampling: PriceSampling = "day",
    manager?: EntityManager,
  ): Promise<Map<string, LoadedPriceSeries>> {
    if (codes.length === 0) return new Map();
    const load = (m: EntityManager) =>
      loadPriceSeries(m, {
        table: "market_index_prices",
        ids: codes,
        fromDate,
        toDate,
        sampling,
      });
    return manager
      ? load(manager)
      : withScopedDb(this.dataSource, (m) => load(m));
  }

  /**
   * Make sure each index's stored history reaches back to `fromDate` and
   * forward to roughly now, fetching what is missing.
   *
   * Awaited rather than fired and forgotten: a chart that renders before its
   * data arrives shows an index as unavailable and gives the reader no reason to
   * try again. The cooldown is what keeps that affordable -- an index the
   * provider will not serve is asked at most once every
   * `INDEX_FETCH_COOLDOWN_MS`, not once per render.
   *
   * Failures are recorded and swallowed. A provider outage must leave the index
   * *unpriced*, which the comparison then reports as an exclusion; turning it
   * into a request failure would take the securities' lines down with it.
   */
  async ensureHistory(
    codes: readonly string[],
    fromDate: string | null,
  ): Promise<void> {
    if (codes.length === 0) return;
    const definitions = codes
      .map((code) => marketIndexByCode(code))
      .filter((index): index is MarketIndexDefinition => index !== undefined);
    if (definitions.length === 0) return;

    const [coverage, attempts] = await Promise.all([
      this.coverageFor(definitions.map((index) => index.code)),
      this.lastAttempts(definitions.map((index) => index.code)),
    ]);

    const now = Date.now();
    const today = todayYMD();
    // The lookup that prices the window's start searches backwards, so the
    // fetch has to reach behind the boundary by the same span the rule accepts.
    // A null `fromDate` is "all time", which has no boundary to reach behind:
    // the whole history is what is wanted, and no stored start can satisfy it.
    const wantedFrom = fromDate
      ? withLeadDays(fromDate, PRICE_WINDOW_LEAD_DAYS)
      : null;
    const staleBefore = withLeadDays(today, TOP_UP_AFTER_DAYS);
    const acceptableStart = wantedFrom
      ? withLeadDays(wantedFrom, -COVERAGE_TOLERANCE_DAYS)
      : null;

    const due = definitions.filter((index) => {
      const attempted = attempts.get(index.code);
      if (attempted && now - attempted.getTime() < INDEX_FETCH_COOLDOWN_MS) {
        return false;
      }
      const held = coverage.get(index.code);
      if (!held?.earliestDate || !held.latestDate) return true;
      if (held.latestDate < staleBefore) return true;
      // With no requested start, whatever is stored is the history: only
      // staleness at the near end can make it due. Treating "all time" as
      // unsatisfiable would refetch every index on every open-ended request.
      return acceptableStart !== null && held.earliestDate > acceptableStart;
    });

    for (const index of due) {
      // An index we hold nothing for gets its whole history, whatever window
      // was asked for. A bounded first fetch would store exactly the requested
      // span and then sit behind the cooldown for six hours, so a user who
      // widened the window straight afterwards would be told the benchmark
      // could not be priced at the new boundary.
      const held = coverage.get(index.code);
      const from = held?.earliestDate ? wantedFrom : null;
      await this.fetchInto(index, from, today);
    }
  }

  /**
   * Warm the store once at start-up.
   *
   * Without this a fresh deployment holds no index prices until the first
   * weekday 17:10 ET, and the picker has nothing useful to say about any of
   * them until then. Deliberately not awaited: an outbound provider call must
   * not sit between the process starting and it serving requests.
   */
  onApplicationBootstrap(): void {
    void withSystemContext(() => this.refreshAll()).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Initial market index refresh failed: ${message}`);
    });
  }

  /**
   * Weekday refresh, five minutes after the FX refresh and ten after the
   * security prices, so the three do not contend for the same provider at the
   * same instant.
   *
   * Cross-user work with no request behind it, so it seeds its own system
   * context (`backend/CLAUDE.md`, cron section).
   */
  @Cron("10 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledRefresh(): Promise<void> {
    await withSystemContext(() => this.refreshAll());
  }

  /**
   * Top every catalog index up with recent closes, and backfill from scratch any
   * that hold nothing yet.
   */
  async refreshAll(): Promise<void> {
    const today = todayYMD();
    const coverage = await this.coverageFor(
      MARKET_INDEXES.map((index) => index.code),
    );
    for (const index of MARKET_INDEXES) {
      const held = coverage.get(index.code);
      const from = held?.latestDate
        ? withLeadDays(today, REFRESH_WINDOW_DAYS)
        : null;
      await this.fetchInto(index, from, today);
    }
  }

  /**
   * One provider call for one index, written into the store.
   *
   * `from === null` means "everything the provider has", which is what a first
   * sight of an index needs. A bounded window is the ordinary case and is
   * dramatically cheaper: the max range for an index is thousands of bars.
   */
  private async fetchInto(
    index: MarketIndexDefinition,
    from: string | null,
    to: string,
  ): Promise<void> {
    await this.recordAttempt(index.code);
    try {
      const prices = from
        ? await this.yahooFinanceService.fetchHistoricalWindow(
            index.yahooSymbol,
            new Date(`${from}T00:00:00Z`),
            new Date(`${to}T23:59:59Z`),
          )
        : await this.yahooFinanceService.fetchHistorical(index.yahooSymbol);

      if (!prices?.length) {
        await this.recordFailure(
          index.code,
          `no history returned for ${index.yahooSymbol}`,
        );
        return;
      }

      const rows: UpsertRow[] = prices
        .filter((price) => Number.isFinite(price.close) && price.close > 0)
        .map((price) => ({
          indexCode: index.code,
          priceDate: price.date.toISOString().slice(0, 10),
          closePrice: price.close,
          adjustedClose:
            price.adjClose !== null && Number.isFinite(price.adjClose)
              ? price.adjClose
              : null,
        }));

      if (rows.length === 0) {
        await this.recordFailure(
          index.code,
          `every bar for ${index.yahooSymbol} was unusable`,
        );
        return;
      }

      await this.bulkUpsert(rows);
      await this.recordSuccess(index.code);
      this.logger.log(
        `Stored ${rows.length} close(s) for ${index.code} (${index.yahooSymbol})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(index.code, message);
      this.logger.warn(
        `Market index refresh failed for ${index.code}: ${message}`,
      );
    }
  }

  /** Where each index's stored history begins and ends. */
  private async coverageFor(
    codes: readonly string[],
  ): Promise<Map<string, MarketIndexCoverage>> {
    const result = new Map<string, MarketIndexCoverage>();
    if (codes.length === 0) return result;
    const rows: Array<{
      index_code: string;
      earliest: string | null;
      latest: string | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT index_code,
                MIN(price_date)::text AS earliest,
                MAX(price_date)::text AS latest
           FROM market_index_prices
          WHERE index_code = ANY($1::text[])
          GROUP BY index_code`,
        [codes],
      ),
    );
    for (const row of rows) {
      result.set(row.index_code, {
        earliestDate: row.earliest,
        latestDate: row.latest,
      });
    }
    return result;
  }

  /** When each index was last asked for, successfully or not. */
  private async lastAttempts(
    codes: readonly string[],
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (codes.length === 0) return result;
    const rows: Array<{ index_code: string; last_attempt_at: Date | null }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT index_code, last_attempt_at
             FROM market_index_sync
            WHERE index_code = ANY($1::text[])`,
          [codes],
        ),
      );
    for (const row of rows) {
      if (row.last_attempt_at) {
        result.set(row.index_code, new Date(row.last_attempt_at));
      }
    }
    return result;
  }

  private async recordAttempt(code: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `INSERT INTO market_index_sync (index_code, last_attempt_at)
         VALUES ($1, NOW())
         ON CONFLICT (index_code)
         DO UPDATE SET last_attempt_at = NOW()`,
        [code],
      ),
    );
  }

  private async recordSuccess(code: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `UPDATE market_index_sync
            SET last_success_at = NOW(), last_error = NULL
          WHERE index_code = $1`,
        [code],
      ),
    );
  }

  private async recordFailure(code: string, message: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `UPDATE market_index_sync SET last_error = $2 WHERE index_code = $1`,
        [code, message.slice(0, 1000)],
      ),
    );
  }

  /**
   * Write the fetched bars.
   *
   * `adjusted_close` is COALESCEd against the stored value for the same reason
   * `SecurityPriceService.bulkUpsertPrices` does it: a later provider that
   * supplies no adjusted close must not erase one an earlier fetch stored, or
   * the series' basis silently flips from adjusted to raw between two reads.
   */
  private async bulkUpsert(rows: readonly UpsertRow[]): Promise<void> {
    const BATCH = 500;
    for (let offset = 0; offset < rows.length; offset += BATCH) {
      const batch = rows.slice(offset, offset + BATCH);
      const values: unknown[] = [];
      const tuples = batch.map((row, i) => {
        const base = i * 5;
        values.push(
          row.indexCode,
          row.priceDate,
          row.closePrice,
          row.adjustedClose,
          SOURCE,
        );
        return `($${base + 1}, $${base + 2}::date, $${base + 3}, $${base + 4}, $${base + 5})`;
      });
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `INSERT INTO market_index_prices
             (index_code, price_date, close_price, adjusted_close, source)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (index_code, price_date) DO UPDATE
             SET close_price = EXCLUDED.close_price,
                 adjusted_close = COALESCE(EXCLUDED.adjusted_close,
                                           market_index_prices.adjusted_close),
                 source = EXCLUDED.source`,
          values,
        ),
      );
    }
  }
}
