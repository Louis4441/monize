import { roundFxRate } from "../common/fx-entry.util";

/**
 * The one orientation a currency pair is stored in, and the only way a row
 * reaches `INSERT INTO exchange_rates`.
 *
 * `exchange_rates` used to hold two rows per pair and date: the direction a
 * provider was asked for, and `roundFxRate(1 / rate)` written beside it so a
 * reverse lookup would find something. Nothing kept the two reciprocal. A write
 * that touched one side only -- a Money import upserting `CAD->USD` for a date a
 * provider had written both ways -- left a pair whose two rows disagreed, and
 * `resolveFxRate` picks the more recently observed direction, so which figure a
 * date resolved to depended on which row happened to be newer. Two totals in one
 * report could then disagree with nothing saying so.
 *
 * Storing one orientation removes the class rather than the symptom: there is no
 * second row to diverge from. Readers lose nothing, because `resolveFxRate`
 * already consults both directions and inverts the reverse observation
 * (`docs/specs/exchange-rate-canonical-orientation.md`, INV-FX-003).
 */

/**
 * Whether `from -> to` is the orientation a pair is stored in.
 *
 * Plain code-point order, which is what `[from, to].sort()` gives for the
 * three-letter uppercase codes this table holds. The rule has to be
 * user-independent: "foreign to the reporting currency" would orient a shared
 * table by whichever user's refresh ran first.
 */
export function isCanonicalOrientation(from: string, to: string): boolean {
  return from < to;
}

/** A row as it is stored: the canonical orientation and the rate for it. */
export interface CanonicalRateRow {
  from: string;
  to: string;
  rate: number;
}

/**
 * The row to store for an observation of `from -> to` at `rate`, or `null` when
 * there is nothing to store.
 *
 * `null` for equal codes (1 is not an observation; `resolveFxRate` answers a
 * same-currency lookup without reading anything) and for a rate that is not a
 * positive finite number -- zero, negative and `NaN` are absent, not applicable,
 * because multiplying by them reports a real holding as worthless or inverts its
 * sign (INV-FX-001).
 *
 * A non-canonical observation is inverted at the rate column's own precision,
 * ten decimals, never money precision: 1 / 1.3652 rounded to four places is
 * 0.7325, which converts back to 1.3661, an error a statement quoting six
 * decimals shows up immediately. At ten places the round trip is within 1e-9.
 */
export function canonicalRateRow(
  from: string,
  to: string,
  rate: number,
): CanonicalRateRow | null {
  if (!from || !to || from === to) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  return isCanonicalOrientation(from, to)
    ? { from, to, rate }
    : { from: to, to: from, rate: roundFxRate(1 / rate) };
}
