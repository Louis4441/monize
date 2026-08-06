import { EntityManager } from "typeorm";
import { PricePoint } from "./price-boundary.util";

/**
 * Loading a price series with **one basis per series**.
 *
 * `docs/time-series-contract.md` rule 1: a return, performance or backtest
 * calculation reads adjusted closes, and it must never mix adjusted and raw
 * prices for the same instrument. A per-row `COALESCE(adjusted_close,
 * close_price)` looks like "adjusted, falling back where the provider gave
 * none" and is in fact a splice -- `adjusted_close` is nullable per row and only
 * the provider backfill writes it, so transaction-derived prices, imports and
 * seeds all insert a raw close beside it. Around a split that is a
 * several-hundred-percent return and a drawdown that never happened.
 *
 * So the basis is decided once per series over the window being read: if any row
 * in it carries an adjusted close, the series is the adjusted rows only and the
 * unadjusted rows are left out rather than converted. If none does, the series
 * is raw throughout -- consistent, and the only series available for an
 * instrument nobody has adjusted data for.
 *
 * This lives under `common/` because two tables now hold the same shape: the
 * user-owned `security_prices` and the global `market_index_prices`. The GEM
 * report and the Security Performance comparison read through this one function,
 * so there is a single place the rule can be got right or wrong.
 */

/** Tables carrying the `(<id>, price_date, close_price, adjusted_close)` shape. */
export type PriceSeriesTable = "security_prices" | "market_index_prices";

/** Which basis actually answered, per series. */
export type PriceBasis = "ADJUSTED" | "RAW";

/** How densely the window is sampled. */
export type PriceSampling = "day" | "week" | "month";

interface TableShape {
  idColumn: string;
  idCast: string;
}

/**
 * Physical details per table. Both values are compile-time constants selected by
 * a union member -- no request input reaches the SQL string, which is what keeps
 * the interpolation below inside the parameterized-queries-only rule.
 */
const TABLE_SHAPES: Record<PriceSeriesTable, TableShape> = {
  security_prices: { idColumn: "security_id", idCast: "uuid[]" },
  market_index_prices: { idColumn: "index_code", idCast: "text[]" },
};

/** One instrument's series, with the basis that produced it. */
export interface LoadedPriceSeries {
  points: PricePoint[];
  basis: PriceBasis;
}

export interface LoadPriceSeriesParams {
  table: PriceSeriesTable;
  /** Security ids, or index codes. */
  ids: readonly string[];
  /** Inclusive lower bound, ISO `yyyy-MM-dd`. */
  fromDate: string;
  /** Inclusive upper bound, ISO `yyyy-MM-dd`. Omitted means "to the end". */
  toDate?: string;
  sampling?: PriceSampling;
}

interface SeriesRow {
  series_id: string;
  price_date: string;
  close_price: string;
  has_adjusted: boolean;
}

/**
 * Close prices per instrument, oldest first, thinned to the requested sampling.
 * Weekly/monthly sampling keeps the last close of each bucket (`DISTINCT ON`),
 * which is what a period-end comparison wants.
 *
 * An instrument with no usable rows in the window is **absent from the map**,
 * which is what tells "nothing to price it with" apart from "priced at zero".
 *
 * The caller supplies the `EntityManager`, so this joins whatever transaction is
 * already open rather than opening its own.
 */
export async function loadPriceSeries(
  manager: EntityManager,
  params: LoadPriceSeriesParams,
): Promise<Map<string, LoadedPriceSeries>> {
  const series = new Map<string, LoadedPriceSeries>();
  const { table, ids, fromDate, toDate, sampling = "day" } = params;
  if (ids.length === 0) return series;

  const { idColumn, idCast } = TABLE_SHAPES[table];
  const values: unknown[] = [ids, fromDate];
  const upperBound = toDate
    ? `AND price_date <= $${values.push(toDate)}::date`
    : "";

  // `scoped` is the window; `basis` decides, per instrument, whether that window
  // holds any adjusted data at all; `chosen` keeps one basis throughout.
  const oneBasis = `
      WITH scoped AS (
        SELECT ${idColumn} AS series_id, price_date, close_price, adjusted_close
          FROM ${table}
         WHERE ${idColumn} = ANY($1::${idCast})
           AND price_date >= $2::date
           ${upperBound}
           AND close_price IS NOT NULL
      ),
      basis AS (
        SELECT series_id, bool_or(adjusted_close IS NOT NULL) AS has_adjusted
          FROM scoped
         GROUP BY series_id
      ),
      chosen AS (
        SELECT s.series_id,
               s.price_date,
               CASE WHEN b.has_adjusted THEN s.adjusted_close
                    ELSE s.close_price END AS close_price,
               b.has_adjusted
          FROM scoped s
          JOIN basis b ON b.series_id = s.series_id
         WHERE b.has_adjusted = false OR s.adjusted_close IS NOT NULL
      )`;

  const sql =
    sampling === "day"
      ? `${oneBasis}
         SELECT series_id, price_date::text AS price_date, close_price, has_adjusted
           FROM chosen
          ORDER BY series_id, price_date`
      : `${oneBasis}
         SELECT DISTINCT ON (series_id, bucket)
                series_id, price_date::text AS price_date, close_price, has_adjusted
           FROM (
             SELECT series_id, price_date, close_price, has_adjusted,
                    date_trunc($${values.push(sampling)}, price_date) AS bucket
               FROM chosen
           ) sampled
          ORDER BY series_id, bucket, price_date DESC`;

  const rows: SeriesRow[] = await manager.query(sql, values);

  for (const row of rows) {
    const existing = series.get(row.series_id) ?? {
      points: [],
      basis: (row.has_adjusted ? "ADJUSTED" : "RAW") as PriceBasis,
    };
    existing.points.push({
      date: row.price_date,
      close: Number(row.close_price),
    });
    series.set(row.series_id, existing);
  }
  // `DISTINCT ON` returns descending dates within a bucket group; normalise so
  // every consumer can assume oldest-first (`pointAsOf` binary-searches on it).
  for (const loaded of series.values()) {
    loaded.points.sort((a, b) => a.date.localeCompare(b.date));
  }
  return series;
}
