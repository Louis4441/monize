/**
 * The one door between the stored exchange-rate history and a converted amount
 * "as of" a date.
 *
 * A reporting figure that spans currencies is converted at the rate that stood
 * on the day being reported, not the latest rate: a chart point for last March
 * priced at today's rate is a different number every morning. Two services now
 * need that -- `NetWorthService`, which owns every chart that spans currencies,
 * and `DailyBalanceTotalsService`, which sums a calendar day's account balances
 * -- so the query, the index it builds, the direct/inverse decision and the
 * look-ahead fallback live here rather than in one service the other copies.
 *
 * The rules this module holds, none of which a caller may restate:
 *
 *  - A rate is looked up **on or before** the date being priced, taking the most
 *    recent one. `findBestRate` walks the (date-ordered) array forward, which is
 *    why `buildRateIndex` must keep the query's `ORDER BY rate_date`.
 *  - A pair with no rate converts to `null`, never to the amount unchanged and
 *    never at 1:1 (audit P5-009, INV-FX-001). Callers accumulate through
 *    `FxAggregate`, which keeps "could not convert" apart from "converted to
 *    zero".
 *  - Zero converts to zero at any rate and records no gap: an emptied account in
 *    a currency with no stored rates is a settled zero, not an unknowable value.
 *  - The one look-ahead in the codebase (a date that predates the whole stored
 *    history falls back to the earliest rate) is kept, and kept visible: it is
 *    DR-02 in the audit and `docs/specs/fx-conversion-completeness.md` section 6
 *    is where changing it would be decided. It warns once per pair per
 *    computation rather than once per point.
 */
import { convertWithRateLookup } from "../currency-conversion.util";

/** `"USD->CAD"` -> the stored rates for that pair, ascending by date. */
export type RateIndex = Map<string, Array<{ date: string; rate: number }>>;

/** One `exchange_rates` row, as the query below returns it. */
export interface RateIndexRow {
  from_currency: string;
  to_currency: string;
  rate: string | number;
  rate_date: string | Date | null;
}

/** Runs one parameterized statement; supplied by the caller's scoped door. */
export type RateIndexQuery = (
  sql: string,
  params: unknown[],
) => Promise<RateIndexRow[]>;

/** Only `warn` is used; `Logger` and `console` both satisfy it. */
export interface RateIndexLogger {
  warn(message: string): void;
}

/**
 * Rates are loaded with a margin either side of the reported window: a date at
 * the very start of the window is priced by a rate struck before it, and the
 * trailing margin covers a projection priced at a rate stored slightly ahead.
 */
const RATE_LOOKBACK_DAYS = 90;
const RATE_LOOKAHEAD_DAYS = 31;

/**
 * Every stored rate between the reporting currency and each of `currencies`,
 * in either direction, indexed by pair.
 *
 * Both directions are loaded because `convertWithRateLookup` accepts an inverse
 * rate when the direct pair is absent; dropping one direction here would make
 * that fallback unreachable for half the pairs.
 */
export async function buildRateIndex(
  query: RateIndexQuery,
  currencies: Set<string>,
  defaultCurrency: string,
  startDate: string,
  endDate: string,
): Promise<RateIndex> {
  if (currencies.size === 0) return new Map();

  const currArr = Array.from(currencies);
  const rates = await query(
    `SELECT from_currency, to_currency, rate, rate_date
       FROM exchange_rates
       WHERE ((from_currency = ANY($1::TEXT[]) AND to_currency = $2)
           OR (from_currency = $2 AND to_currency = ANY($1::TEXT[])))
         AND rate_date >= ($3::DATE - INTERVAL '${RATE_LOOKBACK_DAYS} days')
         AND rate_date <= ($4::DATE + INTERVAL '${RATE_LOOKAHEAD_DAYS} days')
       ORDER BY rate_date`,
    [currArr, defaultCurrency, startDate, endDate],
  );

  return indexRateRows(rates);
}

/** Group already-fetched rows into the pair index, preserving their order. */
export function indexRateRows(rows: RateIndexRow[]): RateIndex {
  const index: RateIndex = new Map();
  for (const r of rows) {
    const key = `${r.from_currency}->${r.to_currency}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push({
      date: rateDateString(r.rate_date),
      rate: Number(r.rate),
    });
  }
  return index;
}

/**
 * Rate arrays whose look-ahead fallback has already been logged. Keyed by the
 * per-request array object in the index, so each pair warns once per
 * computation instead of once per chart point.
 */
const lookAheadWarned = new WeakSet<Array<{ date: string; rate: number }>>();

/**
 * The most recent stored rate for `pair` dated on or before `beforeOrOn`.
 *
 * Falls back to the earliest stored rate when the date predates the pair's whole
 * history. That is look-ahead -- valuing a point with a rate from its future --
 * and `docs/time-series-contract.md` forbids it in general. It is kept
 * deliberately (DR-02): a chart point that predates the rate history is more
 * useful approximated than absent. What is NOT acceptable is it being invisible,
 * which is what the warning is for.
 */
export function findBestRate(
  rates: Array<{ date: string; rate: number }>,
  pair: string,
  beforeOrOn: string,
  logger?: RateIndexLogger,
): number | undefined {
  let best: number | undefined;
  for (const r of rates) {
    if (r.date <= beforeOrOn) best = r.rate;
    else break;
  }
  if (best === undefined && rates.length > 0) {
    if (!lookAheadWarned.has(rates)) {
      lookAheadWarned.add(rates);
      logger?.warn(
        `Valuation on or before ${beforeOrOn} predates the stored ${pair} rate history; using the earliest stored rate (look-ahead, DR-02)`,
      );
    }
    best = rates[0].rate;
  }
  return best;
}

/**
 * Date-aware conversion into the reporting currency. Returns `null` when no
 * rate exists for the pair, in either direction, at or before `onOrBefore`.
 *
 * `null`, not the amount unchanged: the predecessor of this function ended in
 * `result ?? amount`, which reported 1,000 USD as 1,000 EUR and left a consumer
 * unable to tell that from a genuine 1:1 pair (audit P5-009).
 */
export function convertAtDate(
  amount: number,
  from: string,
  to: string,
  onOrBefore: string,
  rateIndex: RateIndex,
  logger?: RateIndexLogger,
): number | null {
  // Zero converts to zero at any rate, so it needs none (and records no gap):
  // an emptied account in a currency with no stored rates is a settled zero,
  // not an unknowable value, and flagging it incomplete would report a question
  // that was never open as one that could not be answered.
  if (amount === 0) return 0;

  const converted = convertWithRateLookup(amount, from, to, (f, t) => {
    const rates = rateIndex.get(`${f}->${t}`);
    return rates
      ? findBestRate(rates, `${f}->${t}`, onOrBefore, logger)
      : undefined;
  });
  if (converted === null) {
    logger?.warn(
      `No exchange rate available for ${from}->${to} on or around ${onOrBefore}; the affected total is reported as unknown rather than converted 1:1`,
    );
  }
  return converted;
}

/**
 * A DATE column as `YYYY-MM-DD`, whether the driver handed back text or a Date.
 *
 * A row with no date at all falls back to today, which is what the net-worth
 * service's own `toDateString` did before this extraction and what its fixtures
 * rely on. `exchange_rates.rate_date` is `NOT NULL`, so the branch is reachable
 * only from a hand-built row.
 */
function rateDateString(value: string | Date | null | undefined): string {
  if (!value) return new Date().toISOString().substring(0, 10);
  if (typeof value === "string") return value.substring(0, 10);
  return value.toISOString().substring(0, 10);
}
