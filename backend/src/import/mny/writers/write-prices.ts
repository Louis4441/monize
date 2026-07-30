import { EntityManager } from "typeorm";
import { roundToDecimals } from "../../../common/round.util";
import { MnyExchangeRate, MnySecurityPrice } from "../model/mny-rows";
import { chunk } from "./chunk";

/**
 * Bulk writers for `SP` price history and `CRNC_EXCHG` exchange rates.
 *
 * Both are additive upserts on the natural key the table is already unique on,
 * so importing the same file twice, or importing on top of prices a quote
 * provider fetched, converges rather than failing or duplicating. The Money file
 * wins on a conflict: the user asked to import it, and its history is the one
 * their transactions were entered against.
 *
 * These are the two biggest tables in a real file -- the maintainer's Money Plus
 * file has 68,000 price rows -- so they go in as multi-row `INSERT ... ON
 * CONFLICT` statements with a smaller chunk than the transaction writer uses,
 * because each row binds more parameters.
 */

/** 500 rows x 5 columns stays well inside Postgres's 65,535-parameter ceiling. */
export const UPSERT_CHUNK_SIZE = 500;

/** `security_prices.close_price` is `numeric(20,6)`. */
const PRICE_DECIMALS = 6;

/** `exchange_rates.rate` is `numeric(20,10)`. */
const RATE_DECIMALS = 10;

/** Marks the rows this import wrote, alongside `yahoo_finance` and friends. */
export const MNY_PRICE_SOURCE = "mny_import";

export interface PriceRow {
  readonly securityId: string;
  readonly priceDate: string;
  readonly closePrice: number;
}

/**
 * The last usable price per `(security, date)`.
 *
 * Money keeps several `SP` rows for one security and day -- an intraday quote
 * and the close, or a re-fetch. `hsp` is monotonic, so the highest handle is the
 * most recently written one and wins; rows without a handle fall back to file
 * order. Deduping here rather than letting the upsert do it keeps the statement
 * free of the "ON CONFLICT DO UPDATE cannot affect row a second time" error that
 * duplicate keys inside a single `VALUES` list would raise.
 */
export function dedupePrices(
  prices: readonly MnySecurityPrice[],
  securityIdByHandle: ReadonlyMap<number, string>,
): PriceRow[] {
  const byKey = new Map<string, { handle: number; row: PriceRow }>();

  prices.forEach((price, index) => {
    if (price.security === null || price.date === null) {
      return;
    }
    const securityId = securityIdByHandle.get(price.security);
    if (securityId === undefined) {
      return;
    }
    const closePrice = roundToDecimals(price.price, PRICE_DECIMALS);
    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      return;
    }

    const key = `${securityId}|${price.date}`;
    const handle = price.handle ?? index;
    const existing = byKey.get(key);
    if (existing === undefined || handle >= existing.handle) {
      byKey.set(key, {
        handle,
        row: { securityId, priceDate: price.date, closePrice },
      });
    }
  });

  return [...byKey.values()].map((entry) => entry.row);
}

export async function writeSecurityPrices(
  manager: EntityManager,
  prices: readonly MnySecurityPrice[],
  securityIdByHandle: ReadonlyMap<number, string>,
  onProgress?: (processed: number, total: number) => Promise<void>,
): Promise<number> {
  const rows = dedupePrices(prices, securityIdByHandle);
  let processed = 0;

  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const values = batch
      .map(
        (_, index) =>
          `($${index * 4 + 1}::uuid, $${index * 4 + 2}::date, $${index * 4 + 3}::numeric, $${index * 4 + 4})`,
      )
      .join(", ");
    await manager.query(
      `INSERT INTO security_prices (security_id, price_date, close_price, source)
            VALUES ${values}
       ON CONFLICT (security_id, price_date)
       DO UPDATE SET close_price = EXCLUDED.close_price,
                     source = EXCLUDED.source`,
      batch.flatMap((row) => [
        row.securityId,
        row.priceDate,
        row.closePrice,
        MNY_PRICE_SOURCE,
      ]),
    );
    processed += batch.length;
    await onProgress?.(processed, rows.length);
  }

  return rows.length;
}

export interface ExchangeRateRow {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: number;
  readonly rateDate: string;
}

/**
 * Resolves `CRNC_EXCHG` handles into ISO codes, dropping what cannot be used.
 *
 * A rate needs both currencies, a date and a positive rate; a row missing any of
 * those describes nothing. Self-rates (`USD -> USD`) are dropped too: they are
 * always 1 and only get in the way of the rate lookup.
 */
export function resolveExchangeRates(
  rates: readonly MnyExchangeRate[],
  currencyByHandle: ReadonlyMap<number, string>,
): ExchangeRateRow[] {
  const byKey = new Map<string, ExchangeRateRow>();

  for (const rate of rates) {
    if (rate.fromCurrency === null || rate.toCurrency === null) {
      continue;
    }
    const fromCurrency = currencyByHandle.get(rate.fromCurrency);
    const toCurrency = currencyByHandle.get(rate.toCurrency);
    const value = roundToDecimals(rate.rate, RATE_DECIMALS);

    if (
      fromCurrency === undefined ||
      toCurrency === undefined ||
      fromCurrency === toCurrency ||
      rate.date === null ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      continue;
    }

    // Later rows win, matching the price rule and Money's own write order.
    byKey.set(`${fromCurrency}|${toCurrency}|${rate.date}`, {
      fromCurrency,
      toCurrency,
      rate: value,
      rateDate: rate.date,
    });
  }

  return [...byKey.values()];
}

export async function writeExchangeRates(
  manager: EntityManager,
  rates: readonly MnyExchangeRate[],
  currencyByHandle: ReadonlyMap<number, string>,
): Promise<number> {
  const rows = resolveExchangeRates(rates, currencyByHandle);

  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const values = batch
      .map(
        (_, index) =>
          `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}::numeric, $${index * 5 + 4}::date, $${index * 5 + 5})`,
      )
      .join(", ");
    await manager.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source)
            VALUES ${values}
       ON CONFLICT (from_currency, to_currency, rate_date)
       DO UPDATE SET rate = EXCLUDED.rate,
                     source = EXCLUDED.source`,
      batch.flatMap((row) => [
        row.fromCurrency,
        row.toCurrency,
        row.rate,
        row.rateDate,
        MNY_PRICE_SOURCE,
      ]),
    );
  }

  return rows.length;
}
