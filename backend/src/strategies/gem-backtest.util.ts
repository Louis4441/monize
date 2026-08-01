import { roundToDecimals } from "../common/round.util";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { PricePoint, priceAsOf } from "./gem-momentum.util";

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

/** Growth of one security between two dates, or null when either price is missing. */
function growth(
  series: PricePoint[] | undefined,
  from: string,
  to: string,
): number | null {
  if (!series?.length) return null;
  const entry = priceAsOf(series, from);
  const exit = priceAsOf(series, to);
  if (entry === null || exit === null || entry <= 0) return null;
  return exit / entry;
}

/**
 * Simulate the stored signals and summarise the run.
 *
 * Returns null when there is nothing honest to report: fewer than two
 * evaluations, or no period whose prices could be found. A partially priced
 * history is simulated over the periods that can be priced -- the unpriced ones
 * are held flat rather than dropped, so the timeline does not silently
 * compress. Flat is a return of zero, though, which nobody measured, so the
 * annualisation counts only the priced span and `coveragePercent` reports how
 * much of the run that was.
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
  }));
  const from = bounds[0].effectiveFrom;
  const to = bounds[bounds.length - 1].endsOn;
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
  let pricedPeriods = 0;
  /** Days the simulation actually priced, which is what it can annualise over. */
  let pricedDays = 0;
  let beatSafe = 0;
  let comparedToSafe = 0;

  for (const period of bounds) {
    const securityId = period.targetSecurityId;

    // Entering a different instrument: the old one is sold, which realizes a
    // result and costs two trades. The very first buy costs one.
    //
    // A period with no instrument at all -- RISK-ON with nothing eligible
    // assigned -- is not a trade. Treating it as one charged a commission for
    // holding nothing and then billed the return to the *next* instrument as a
    // first purchase, understating the switch that actually happened.
    if (securityId !== null && securityId !== previousSecurityId) {
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

    const series = securityId ? seriesBySecurity.get(securityId) : undefined;
    const periodGrowth = growth(series, period.effectiveFrom, period.endsOn);

    if (periodGrowth !== null && series) {
      pricedPeriods += 1;
      pricedDays +=
        (Date.parse(`${period.endsOn}T00:00:00Z`) -
          Date.parse(`${period.effectiveFrom}T00:00:00Z`)) /
        86_400_000;
      const entryPrice = priceAsOf(series, period.effectiveFrom) as number;
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
    }

    // Did following the signal beat sitting in the safe asset this period?
    const safeGrowth =
      safeSecurityId && safeSecurityId !== securityId
        ? growth(
            seriesBySecurity.get(safeSecurityId),
            period.effectiveFrom,
            period.endsOn,
          )
        : null;
    if (periodGrowth !== null && safeGrowth !== null) {
      comparedToSafe += 1;
      if (periodGrowth > safeGrowth) beatSafe += 1;
    } else if (periodGrowth !== null && safeSecurityId === securityId) {
      // Holding the safe asset ties with itself; a tie is not a win.
      comparedToSafe += 1;
    }
  }

  if (pricedPeriods === 0) return null;

  // Annualise over the span the simulation could price, not over the calendar.
  // An unpriced stretch is held flat, and dividing the compounded result by the
  // whole window would spread that flatness across it as though the strategy
  // had earned nothing -- turning "we could not price six months" into a
  // reported six months at zero. `coveragePercent` says how much is missing.
  const years = pricedDays / DAYS_PER_YEAR;
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
    coveragePercent: roundToDecimals((pricedPeriods / bounds.length) * 100, 2),
  };
}
