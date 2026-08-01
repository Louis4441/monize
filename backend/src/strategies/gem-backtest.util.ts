import { roundToDecimals } from "../common/round.util";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { PricePoint, closeAt, daysBetween } from "./gem-momentum.util";

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
 * into a drag when the notional the strategy actually runs is known. The result
 * reports the two separately (`taxApplied`, `commissionApplied`), because a
 * configured commission with an unknown portfolio total is a real and common
 * case and one flag would let the report claim the figures were net of a cost
 * nobody deducted.
 */

/** One evaluated period, oldest first, as stored. */
export interface GemBacktestPeriod {
  effectiveFrom: string;
  targetRole: GemAssetRole | null;
  targetSecurityId: string | null;
  /**
   * What the strategy held going into this period, as stored on the signal.
   *
   * Only the first period's matters here, and only as a yes/no: null says the
   * strategy owned nothing before it, so the simulation may open with a real
   * first purchase. Anything else says the run begins mid-strategy -- the
   * history is bounded to the last `GEM_HISTORY_PERIODS` periods, so the oldest
   * retained signal is very often not the first one -- and the opening position
   * and its cost are then unknown.
   */
  previousRole: GemAssetRole | null;
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
  /**
   * Whether the strategy evaluated anything before the oldest period supplied.
   *
   * Answered from the database, not inferred from the first period's
   * `previousRole`: that is set from the current configuration's chain, so it
   * is null whenever the predecessor belonged to another configuration, to an
   * older algorithm version, or simply fell out of the 24-period window. A
   * strategy running for years can present a first period with no predecessor
   * of its own, and reading that as "this is where it began" is what lets the
   * simulation invent an opening trade.
   */
  hasEarlierSignals: boolean;
}

export interface GemBacktestResult {
  from: string;
  to: string;
  cagrPercent: number | null;
  /** Worst peak-to-trough decline, negative. */
  maxDrawdownPercent: number | null;
  /**
   * Share of the simulated periods whose held asset beat the safe asset,
   * 0-100. Null when the comparison cannot be made for every simulated period
   * -- no safe asset configured, or one of them has no safe-asset price.
   *
   * Dropping the periods that cannot be compared and reporting the ratio of
   * what is left would answer a question nobody asked: "of the periods we
   * happened to be able to check, how many won". With three of eight periods
   * checkable, two wins reads as 67% and the figure sits next to a run of
   * eight. A hit rate over an unstated denominator is worse than no hit rate.
   */
  hitRatePercent: number | null;
  /**
   * Whether the configured tax rate was actually deducted.
   *
   * Reported apart from the commission because the two fail independently and
   * one flag cannot say which happened. Commission is an absolute amount and
   * needs a known `notional` to become a drag; tax is a percentage and never
   * does. With both configured and the portfolio total unknown -- which is the
   * ordinary outcome of a single holding nobody could price -- one flag said
   * "net of costs" and the report claimed the figures were net of estimated
   * taxes *and commissions* when no commission had been charged at all.
   */
  taxApplied: boolean;
  /** Whether the configured commission was actually deducted. */
  commissionApplied: boolean;
  /**
   * Share of the evaluated periods the simulation actually covers, 0-100:
   * `simulated periods / evaluated periods`.
   *
   * Below 100 the earlier periods are **excluded**, not held flat. The run is
   * the most recent unbroken stretch of priced periods (see `runBacktest`), so
   * everything up to and including the last unpriceable period is outside the
   * simulation entirely -- it contributes nothing to the return, the drawdown
   * or the hit rate, and `from` is the first period that is in. This is the
   * share of the strategy's history the figures speak for.
   */
  coveragePercent: number;
}

const DAYS_PER_YEAR = 365.25;

/**
 * One evaluation is enough.
 *
 * The last period is bounded by `asOf`, not by the next signal, so a strategy
 * that produced its first signal a month ago has a complete month to simulate:
 * an entry price, an exit price, the daily path between them for the drawdown,
 * and the safe asset over the same interval. Requiring a second evaluation
 * withheld the whole report from exactly the users most likely to look at it,
 * and contradicted the promise that a strategy configured last month reports a
 * month. A period that has not finished, or that cannot be priced, still comes
 * back null on its own further down.
 */
const MIN_PERIODS = 1;

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
 * **A run that does not start where the strategy did is reported gross**,
 * whatever costs are configured -- whether prices truncated it or the oldest
 * retained signal simply had a predecessor, which is the ordinary case for any
 * strategy older than the 24 periods the history keeps. The simulation does not
 * know what was held on `from` or what it cost, so charging an opening
 * commission and dating the tax basis to `from` would invent both. Both cost
 * flags are false and the caller says so.
 *
 * Returns null when there is nothing honest to report: no evaluation at all, no
 * priced period after the last gap, or a single evaluation whose period has not
 * elapsed yet (`to <= from`).
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
    hasEarlierSignals,
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

  // A period that has not started yet is not a period.
  //
  // On the first day of a new one, `effectiveFrom` and `endsOn` are both
  // today: growth is exactly 1, which loses the hit-rate comparison against a
  // safe asset that also did nothing, so the ratio dropped the morning a
  // period opened and climbed back over the month. Nothing about the strategy
  // changed; there was simply no elapsed time to judge.
  const elapsed = bounds.filter(
    (period) => period.endsOn > period.effectiveFrom,
  );
  if (elapsed.length === 0) return null;

  // Everything after the last period that could not be priced.
  const lastGap = elapsed.map((period) => period.growth).lastIndexOf(null);
  const run = elapsed.slice(lastGap + 1);
  if (run.length === 0) return null;

  const from = run[0].effectiveFrom;
  const to = run[run.length - 1].endsOn;
  if (to <= from) return null;

  /**
   * True when the run does not start where the strategy did: prices forced it
   * to skip periods, the strategy had already evaluated something before the
   * oldest period in hand, or that period names a predecessor.
   *
   * Costs cannot be modelled from there, so a truncated run is reported gross.
   * The strategy was already holding something on `from` -- the periods before
   * it were evaluated, they are simply unpriceable -- and the simulation knows
   * neither what nor at what cost. Starting a fresh position instead charges a
   * buy commission for a trade that never happened, and resets the tax basis
   * to the price on `from`: the first switch after that is taxed on the gain
   * since the restart rather than since the real purchase, which is a
   * different, invented number in either direction. "Net of estimated taxes
   * and commissions" would be a claim about a portfolio the user never held.
   */
  const truncated =
    lastGap >= 0 || hasEarlierSignals || run[0].previousRole !== null;

  // An absolute commission only becomes a drag against a known capital.
  const commissionFraction =
    !truncated && commissionAmount !== null && notional !== null && notional > 0
      ? commissionAmount / notional
      : null;
  const taxRate =
    !truncated && taxRatePercent !== null ? taxRatePercent / 100 : null;

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
    // Every simulated period has to be comparable, or the ratio has a
    // denominator the reader cannot see and would take to be the whole run.
    hitRatePercent:
      comparedToSafe === run.length
        ? roundToDecimals((beatSafe / comparedToSafe) * 100, 2)
        : null,
    taxApplied: taxRate !== null,
    commissionApplied: commissionFraction !== null,
    coveragePercent: roundToDecimals((run.length / elapsed.length) * 100, 2),
  };
}
