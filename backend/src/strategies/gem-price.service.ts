import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { PricePoint } from "./gem-momentum.util";
import { GemRange } from "./gem-report.types";

/** How far back each chart range reaches, in months. `null` means "all history". */
const RANGE_MONTHS: Record<GemRange, number | null> = {
  "3M": 3,
  "6M": 6,
  "1Y": 12,
  "3Y": 36,
  "5Y": 60,
  MAX: null,
};

/**
 * Sampling per range. Daily closes are what the shorter windows are for; over
 * several years they would ship tens of thousands of points the chart cannot
 * draw distinctly, so long ranges are thinned to one close per week or month.
 */
const RANGE_SAMPLING: Record<GemRange, "day" | "week" | "month"> = {
  "3M": "day",
  "6M": "day",
  "1Y": "day",
  "3Y": "week",
  "5Y": "month",
  MAX: "month",
};

/** A security's close prices, oldest first. */
export type PriceSeries = PricePoint[];

/** Prices keyed by strategy role, for the roles that have an instrument. */
export type PricesByRole = Partial<Record<GemAssetRole, PriceSeries>>;

export function rangeMonths(range: GemRange): number | null {
  return RANGE_MONTHS[range];
}

export function rangeSampling(range: GemRange): "day" | "week" | "month" {
  return RANGE_SAMPLING[range];
}

/**
 * Price reads for the GEM report. Kept apart from the evaluation and position
 * logic so those receive plain arrays and stay free of SQL.
 */
@Injectable()
export class GemPriceService {
  constructor(private dataSource: DataSource) {}

  /**
   * Close prices per security from `fromDate` onwards, oldest first, thinned to
   * the requested sampling. Weekly/monthly sampling keeps the last close of each
   * bucket (DISTINCT ON), which is what a period-end comparison wants.
   *
   * One query for every security: the report needs four series and issuing four
   * round trips per request buys nothing.
   */
  async loadSeries(
    securityIds: string[],
    fromDate: string,
    sampling: "day" | "week" | "month" = "day",
    manager?: EntityManager,
  ): Promise<Map<string, PriceSeries>> {
    const series = new Map<string, PriceSeries>();
    if (securityIds.length === 0) return series;

    const sql =
      sampling === "day"
        ? `SELECT security_id, price_date::text AS price_date, close_price
             FROM security_prices
            WHERE security_id = ANY($1::uuid[])
              AND price_date >= $2::date
              AND close_price IS NOT NULL
            ORDER BY security_id, price_date`
        : `SELECT DISTINCT ON (security_id, bucket)
                  security_id, price_date::text AS price_date, close_price
             FROM (
               SELECT security_id, price_date, close_price,
                      date_trunc($3, price_date) AS bucket
                 FROM security_prices
                WHERE security_id = ANY($1::uuid[])
                  AND price_date >= $2::date
                  AND close_price IS NOT NULL
             ) sampled
            ORDER BY security_id, bucket, price_date DESC`;

    const params: unknown[] =
      sampling === "day"
        ? [securityIds, fromDate]
        : [securityIds, fromDate, sampling];

    const rows: Array<{
      security_id: string;
      price_date: string;
      close_price: string;
    }> = manager
      ? await manager.query(sql, params)
      : await withScopedDb(this.dataSource, (m) => m.query(sql, params));

    for (const row of rows) {
      const points = series.get(row.security_id) ?? [];
      points.push({ date: row.price_date, close: Number(row.close_price) });
      series.set(row.security_id, points);
    }
    // DISTINCT ON returns descending dates within a bucket group; normalise so
    // every consumer can assume oldest-first (priceAsOf binary-searches on it).
    for (const points of series.values()) {
      points.sort((a, b) => a.date.localeCompare(b.date));
    }
    return series;
  }

  /**
   * Latest close per security, for valuing holdings. A security with no price
   * is absent from the map so callers can tell "not priced" from "worth zero".
   */
  async latestPrices(
    securityIds: string[],
    manager?: EntityManager,
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (securityIds.length === 0) return prices;
    const sql = `SELECT DISTINCT ON (security_id) security_id, close_price
                   FROM security_prices
                  WHERE security_id = ANY($1::uuid[])
                    AND close_price IS NOT NULL
                  ORDER BY security_id, price_date DESC`;
    const rows: Array<{ security_id: string; close_price: string }> = manager
      ? await manager.query(sql, [securityIds])
      : await withScopedDb(this.dataSource, (m) => m.query(sql, [securityIds]));
    for (const row of rows) {
      prices.set(row.security_id, Number(row.close_price));
    }
    return prices;
  }

  /**
   * The most recent price date across the given securities, or null when none
   * has a price. Drives both the report's "prices as of" line and the
   * stale-price warning.
   */
  async latestPriceDate(
    securityIds: string[],
    manager?: EntityManager,
  ): Promise<string | null> {
    if (securityIds.length === 0) return null;
    const sql = `SELECT MAX(price_date)::text AS latest
                   FROM security_prices
                  WHERE security_id = ANY($1::uuid[])`;
    const rows: Array<{ latest: string | null }> = manager
      ? await manager.query(sql, [securityIds])
      : await withScopedDb(this.dataSource, (m) => m.query(sql, [securityIds]));
    return rows[0]?.latest ?? null;
  }

  /**
   * Earliest close date per security. A security with no prices at all is
   * absent from the map, which is what tells "never priced" apart from "priced,
   * but not far enough back" when deciding whether history has to be fetched.
   */
  async earliestPriceDates(
    securityIds: string[],
    manager?: EntityManager,
  ): Promise<Map<string, string>> {
    const earliest = new Map<string, string>();
    if (securityIds.length === 0) return earliest;
    const sql = `SELECT security_id, MIN(price_date)::text AS earliest
                   FROM security_prices
                  WHERE security_id = ANY($1::uuid[])
                    AND close_price IS NOT NULL
                  GROUP BY security_id`;
    const rows: Array<{ security_id: string; earliest: string | null }> =
      manager
        ? await manager.query(sql, [securityIds])
        : await withScopedDb(this.dataSource, (m) =>
            m.query(sql, [securityIds]),
          );
    for (const row of rows) {
      if (row.earliest) earliest.set(row.security_id, row.earliest);
    }
    return earliest;
  }
}
