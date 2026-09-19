import { roundFxRate } from "../common/fx-entry.util";
import {
  canonicalRateRow,
  isCanonicalOrientation,
} from "./canonical-rate.util";

/**
 * The truth table in `docs/specs/exchange-rate-canonical-orientation.md`
 * section 4. The property that matters is that two observations of one pair --
 * one given each way -- produce rows with the same key, so they cannot sit in
 * the table disagreeing with each other.
 */
describe("canonicalRateRow", () => {
  it("keeps an observation that is already canonical", () => {
    expect(canonicalRateRow("CAD", "USD", 0.7143)).toEqual({
      from: "CAD",
      to: "USD",
      rate: 0.7143,
    });
  });

  it("swaps and inverts an observation stored the other way", () => {
    expect(canonicalRateRow("USD", "CAD", 1.4)).toEqual({
      from: "CAD",
      to: "USD",
      rate: roundFxRate(1 / 1.4),
    });
  });

  it("inverts at rate precision, not money precision", () => {
    // 1 / 1.3652 at four places is 0.7325, which converts back to 1.3661 -- an
    // error a statement quoting six decimals reconciles against by cents.
    const row = canonicalRateRow("USD", "CAD", 1.3652);

    expect(row?.rate).toBe(roundFxRate(1 / 1.3652));
    expect(row?.rate).not.toBe(0.7325);
    expect(roundFxRate(1 / (row as { rate: number }).rate)).toBeCloseTo(
      1.3652,
      9,
    );
  });

  it("gives both directions of one observation the same key", () => {
    const direct = canonicalRateRow("USD", "CAD", 1.4);
    const reverse = canonicalRateRow("CAD", "USD", roundFxRate(1 / 1.4));

    expect(direct?.from).toBe(reverse?.from);
    expect(direct?.to).toBe(reverse?.to);
    expect(direct?.rate).toBeCloseTo(reverse?.rate as number, 9);
  });

  it("is idempotent: canonicalising its own output changes nothing", () => {
    const once = canonicalRateRow("USD", "CAD", 1.4);
    const twice = canonicalRateRow(
      (once as CanonicalRow).from,
      (once as CanonicalRow).to,
      (once as CanonicalRow).rate,
    );

    expect(twice).toEqual(once);
  });

  it("has nothing to store for a same-currency pair", () => {
    // 1 is not an observation: a same-currency lookup is answered without
    // reading the history at all (INV-FX-001).
    expect(canonicalRateRow("USD", "USD", 1)).toBeNull();
  });

  it("treats a non-positive rate as absent rather than applicable", () => {
    expect(canonicalRateRow("USD", "CAD", 0)).toBeNull();
    expect(canonicalRateRow("USD", "CAD", -1.4)).toBeNull();
  });

  it("refuses a rate that is not a finite number", () => {
    expect(canonicalRateRow("USD", "CAD", Number.NaN)).toBeNull();
    expect(canonicalRateRow("USD", "CAD", Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("has nothing to store when a code is missing", () => {
    expect(canonicalRateRow("", "CAD", 1.4)).toBeNull();
    expect(canonicalRateRow("USD", "", 1.4)).toBeNull();
  });
});

interface CanonicalRow {
  from: string;
  to: string;
  rate: number;
}

describe("isCanonicalOrientation", () => {
  it("orders a pair by its codes", () => {
    expect(isCanonicalOrientation("CAD", "USD")).toBe(true);
    expect(isCanonicalOrientation("USD", "CAD")).toBe(false);
  });

  it("agrees with the sort the directionless pair key uses", () => {
    for (const [a, b] of [
      ["USD", "CAD"],
      ["EUR", "PLN"],
      ["GBP", "USD"],
      ["JPY", "AUD"],
    ]) {
      const [first, second] = [a, b].sort();
      expect(isCanonicalOrientation(first, second)).toBe(true);
    }
  });
});
