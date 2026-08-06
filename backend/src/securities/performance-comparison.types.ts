import {
  PriceBasis,
  PriceSampling,
} from "../common/time-series/price-series.util";

/**
 * The wire shape of the Security Performance comparison.
 *
 * `docs/security-benchmark-comparison.md` is the contract these types encode --
 * read it before changing any of them, because several fields exist only to
 * make a refusal visible and dropping one turns a stated gap into a silent zero.
 */

/** Whether a plotted line is one of the user's instruments or a benchmark. */
export type PerformanceSeriesKind = "SECURITY" | "INDEX";

/** Why an instrument the user selected is not drawn. */
export type PerformanceExclusionReason =
  /** Nothing stored for it anywhere in the loaded range. */
  | "NO_PRICE_HISTORY"
  /**
   * Rows exist, but none close enough to the window's start to stand for it --
   * including the case where the instrument's history simply begins later. It
   * is not rebased on its own first observation instead: that would report the
   * window's return measured from a date the label does not mention.
   */
  | "NO_PRICE_AT_WINDOW_START"
  /** The base close is zero or negative, so a percentage is undefined. */
  | "NON_POSITIVE_BASE"
  /**
   * The base is the only observation in the window, so both ends of the span
   * resolve to one row. The arithmetic would return exactly 0%, which is
   * indistinguishable from an instrument that went nowhere.
   */
  | "SINGLE_OBSERVATION";

/** One plotted line. */
export interface PerformanceSeriesRef {
  /** `sec:<uuid>` or `idx:<code>`; also the key inside `values` and `totals`. */
  key: string;
  kind: PerformanceSeriesKind;
  /** Security id, or index code. */
  id: string;
  /** Ticker, or index code -- what the legend shows. */
  label: string;
  name: string;
  /**
   * The currency the underlying closes are quoted in. Nothing is converted, so
   * this is not the currency of the percentage -- it is what tells the reader
   * which market's money the line was measured in.
   */
  currencyCode: string;
  /** Which price series answered, decided once for the whole window. */
  basis: PriceBasis;
}

/** An instrument that was asked for and is not drawn. */
export interface PerformanceExclusion {
  key: string;
  kind: PerformanceSeriesKind;
  id: string;
  label: string;
  reason: PerformanceExclusionReason;
}

/** A stretch of one series nobody observed. */
export interface PerformanceGap {
  key: string;
  from: string;
  to: string;
}

/** One plotted date, with every included series' value on it. */
export interface PerformancePoint {
  date: string;
  /** Percent return since the window start; null where it is not known. */
  values: Record<string, number | null>;
}

export interface PerformanceComparisonView {
  window: { start: string; end: string };
  sampling: PriceSampling;
  series: PerformanceSeriesRef[];
  points: PerformancePoint[];
  /** Return over the whole window; null where the series does not reach its end. */
  totals: Record<string, number | null>;
  gaps: PerformanceGap[];
  excluded: PerformanceExclusion[];
  /**
   * `complete` only when nothing was excluded, no plotted value is null, and
   * every drawn line reaches the window's end. Anything else is `incomplete`,
   * and the reader is told so rather than left to read a short line as a
   * finished one (`docs/time-series-contract.md` section 4).
   */
  status: "complete" | "incomplete";
}
