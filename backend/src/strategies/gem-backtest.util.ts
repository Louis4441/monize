import { roundToDecimals } from "../common/round.util";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { PricePoint, pointAsOf } from "./gem-momentum.util";

/**
 * Replays the strategy's own stored evaluations against real prices.
 *
 * This is not a re-derivation of the strategy: every period comes from
 * `gem_strategy_signals`, so the simulation answers "what would following these
 * signals have returned", never "what would a better rule have returned". A
 * period the report could not evaluate is absent from the history and is
 * therefore absent here too, rather than being filled with a guess.
 *
 * Costs are the ones the configuration carries. Tax is a percentage and applies
 * to any capital; commission is an absolute amount, so it can only be turned
 * into a drag when the notional the strategy actually runs is known. Whichever
 * of the two is configured is applied, and the result says which.
 */

/** One evaluated period, oldest first, as stored. */
export interface GemBacktestPeriod {
  effectiveFrom: string;
  targetRole: GemAssetRole | null;
  targetSecurityId: string | null;
}

export interface GemBacktestInput {
  /** Evaluated periods, oldest first. */
  periods: GemBacktestPeriod[];
  /** Daily closes per security, oldest first. */
  seriesBySecurity: Map<string, PricePoint[]>;
  /** The risk-off instrument, for the "did the signal beat it" comparison. */
  safeSecurityId: string | null;
  taxRatePercent: number | null;
  commissionAmount: number | null;
  /**
   * Capital the strategy runs, used only to express the absolute commission as
   * a drag. Null or zero leaves commission out of the simulation.
   */
  notional: number | null;
  /** Last day of the simulation: the final period runs up to it. */
  asOf: string;
}

export interface GemBacktestResult {
  from: string;
  to: string;
  cagrPercent: number | null;
  /** Worst peak-to-trough decline, negative. */
  maxDrawdownPercent: number | null;
  /** Share of periods whose held asset beat the safe asset, 0-100. */
  hitRatePercent: number | null;
  /** True when a configured cost was deducted from the figures. */
  netOfCosts: boolean;
  /**
   * Share of the evaluated periods the simulation could actually price, 0-100.
   *
   * Below 100 the run has gaps. They are held flat rather than dropped -- the
   * timeline must not silently compress -- but flat is a *return of zero*, and
   * the figures above must not be read as though the strategy earned nothing
   * over them when the truth is that nobody knows. The annualisation therefore
   * counts only the priced span, and this says how much of the history that
   * was.
   */
  coveragePercent: number;
}

const DAYS_PER_YEAR = 365.25;

/** Two evaluations are the minimum that bound a period with an end price. */
const MIN_PERIODS = 2;

/**
 * How stale a boundary observation may be and still stand for that boundary.
 *
 * A period opens on the 1st, which is regularly a weekend or a holiday, so the
 * close that prices it is the one a few days earlier -- the same reason the
 * signal path loads a lead window. What this must not do is accept *any* older
 * quote: a security last traded in March answers a lookup for September and one
 * for October with the same number, and the period then reads as opening and
 * closing at the same price rather than as one nobody priced.
 */
const BOUNDARY_LAG_DAYS = 14;

/** Whole days between two ISO dates. */
function daysBetween(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000
  );
}

/** The close standing for `date`, or null when the nearest one is too old. */
function closeAt(series: PricePoint[], date: string): number | null {
  const point = pointAsOf(series, date);
  if (!point) return null;
  return daysBetween(point.date, date) <= BOUNDARY_LAG_DAYS
    ? point.close
    : null;
}

/**
 * Growth of one security between two dates, or null when either boundary has no
 * close close enough in time to stand for it.
 */
function growth(
  series: PricePoint[] | undefined,
  from: string,
  to: string,
): number | null {
  if (!series?.length) return null;
  const entry = closeAt(series, from);
  const exit = closeAt(series, to);
  if (entry === null || exit === null || entry <= 0) return null;
  return exit / entry;
}

/**
 * Simulate the stored signals and summarise the run.
 *
 * **The simulated window is the most recent unbroken stretch of priced
 * periods**, not the whole history. Holding an unpriced period flat looked like
 * a modest simplification and was not: flat means the switch out of it realizes
 * nothing, so no tax is deducted, and every later period then compounds from a
 * balance the simulation invented. The drawdown misses whatever happened inside
 * the gap as well, and "net of estimated taxes and commissions" stops being
 * true. A discontinuous equity path cannot be summarised into one CAGR, so the
 * run restarts after the last gap and `from`/`to` say what was actually
 * simulated. Gaps are usually old -- an instrument younger than the history --
 * so this keeps the recent part rather than the part nobody asked about.
 *
 * Returns null when there is nothing honest to report: fewer than two
 * evaluations, or no priced period after the last gap.
 */
export function runBacktest(input: GemBacktestInput): GemBacktestResult | null {
  const {
    periods,
    seriesBySecurity,
    safeSecurityId,
    taxRatePercent,
    commissionAmount,
    notional,
    asOf,
  } = input;

  if (periods.length < MIN_PERIODS) return null;

  const bounds = periods.map((period, index) => ({
    ...period,
    endsOn: periods[index + 1]?.effectiveFrom ?? asOf,
    growth: null as number | null,
  }));
  for (const period of bounds) {
    period.growth = growth(
      period.targetSecurityId
        ? seriesBySecurity.get(period.targetSecurityId)
        : undefined,
      period.effectiveFrom,
      period.endsOn,
    );
  }

  // Everything after the last period that could not be priced.
  const lastGap = bounds.map((period) => period.growth).lastIndexOf(null);
  const run = bounds.slice(lastGap + 1);
  if (run.length === 0) return null;

  const from = run[0].effectiveFrom;
  const to = run[run.length - 1].endsOn;
  if (to <= from) return null;

  // An absolute commission only becomes a drag against a known capital.
  const commissionFraction =
    commissionAmount !== null && notional !== null && notional > 0
      ? commissionAmount / notional
      : null;
  const taxRate = taxRatePercent !== null ? taxRatePercent / 100 : null;

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  /** Equity when the current instrument was bought, for the realized gain. */
  let legEntryEquity = 1;
  let previousSecurityId: string | null = null;
  let beatSafe = 0;
  let comparedToSafe = 0;

  for (const period of run) {
    const securityId = period.targetSecurityId as string;
    const series = seriesBySecurity.get(securityId) as PricePoint[];
    const periodGrowth = period.growth as number;

    // Entering a different instrument: the old one is sold, which realizes a
    // result and costs two trades. The very first buy costs one.
    if (securityId !== previousSecurityId) {
      const trades = previousSecurityId === null ? 1 : 2;
      if (taxRate !== null && previousSecurityId !== null) {
        const gain = equity - legEntryEquity;
        if (gain > 0) equity -= gain * taxRate;
      }
      if (commissionFraction !== null) {
        equity -= commissionFraction * trades;
      }
      legEntryEquity = equity;
      previousSecurityId = securityId;
    }

    const entryPrice = closeAt(series, period.effectiveFrom) as number;
    // Walk the daily closes inside the period so the drawdown reflects what
    // the run actually went through, not only its period-end marks.
    for (const point of series) {
      if (point.date < period.effectiveFrom || point.date > period.endsOn) {
        continue;
      }
      const value = equity * (point.close / entryPrice);
      if (value > peak) peak = value;
      const drawdown = value / peak - 1;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
    equity *= periodGrowth;
    if (equity > peak) peak = equity;

    // Did following the signal beat sitting in the safe asset this period?
    const safeGrowth =
      safeSecurityId && safeSecurityId !== securityId
        ? growth(
            seriesBySecurity.get(safeSecurityId),
            period.effectiveFrom,
            period.endsOn,
          )
        : null;
    if (safeGrowth !== null) {
      comparedToSafe += 1;
      if (periodGrowth > safeGrowth) beatSafe += 1;
    } else if (safeSecurityId === securityId) {
      // Holding the safe asset ties with itself; a tie is not a win.
      comparedToSafe += 1;
    }
  }

  const years = daysBetween(from, to) / DAYS_PER_YEAR;
  const cagrPercent =
    years > 0 && equity > 0
      ? roundToDecimals((Math.pow(equity, 1 / years) - 1) * 100, 2)
      : null;

  return {
    from,
    to,
    cagrPercent,
    maxDrawdownPercent: roundToDecimals(maxDrawdown * 100, 2),
    hitRatePercent:
      comparedToSafe > 0
        ? roundToDecimals((beatSafe / comparedToSafe) * 100, 2)
        : null,
    netOfCosts: taxRate !== null || commissionFraction !== null,
    coveragePercent: roundToDecimals((run.length / bounds.length) * 100, 2),
  };
}
