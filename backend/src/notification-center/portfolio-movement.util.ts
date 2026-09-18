/**
 * The pure decision behind the daily portfolio-movement notification
 * (`docs/specs/portfolio-movement-notifications.md`): given today's portfolio
 * value, the stored baseline, the day's external cash flow and the user's
 * threshold, decide whether to fire and what the new baseline is.
 *
 * Kept free of the database and the cron so the arithmetic and the
 * completeness/withhold policy (INV-PORTMOVE-001..006) are unit-testable in
 * isolation. The producer supplies the inputs and applies the result.
 */
import { roundMoney } from "../common/round.util";

/** A percentage is a ratio, not money -- never round it with `roundMoney` (4dp). */
export const PORTFOLIO_MOVE_PERCENT_DECIMALS = 2;

export interface MovementInputs {
  /** `getPortfolioSummary(...).valuationComplete` for today's run. */
  mvComplete: boolean;
  /** Today's portfolio value (holdings + cash) in the reporting currency. */
  mvToday: number;
  /**
   * False when a held position's latest accepted close predates the baseline
   * date, so part of today's value is carried from before the period being
   * measured (INV-PORTMOVE-008). Such a position contributes an identical
   * carried figure to both ends only for as long as its price stays missing:
   * the run in which the price arrives (or the row disappears) books the whole
   * catch-up as a market move that never happened. The producer passes `true`
   * when there is no baseline date to be stale against.
   */
  pricesCurrentSinceBaseline: boolean;
  /** The reporting currency today's value is in. */
  currency: string;
  /** The stored baseline, or null when none has been captured. */
  baseline: { value: number; currency: string } | null;
  /**
   * Whether the stored baseline carries the date it was captured on.
   *
   * A baseline without one names no period: there is nothing to measure the
   * day's external flow over (INV-PORTMOVE-007), nothing for a held position's
   * close to be stale against (INV-PORTMOVE-008) and no opening date to put in
   * front of the reader. Such a baseline is replaced, not compared.
   */
  baselineDateKnown: boolean;
  /** The day's external cash flow into the investment accounts. */
  flow: { complete: boolean; value: number };
  /** The user's threshold in percent; <= 0 or null means the alert is off. */
  movePercent: number | null;
}

export interface FiredMovement {
  /** The movement as a percentage of the baseline, rounded for display. */
  changePercent: number;
  /** `"up"` for a gain, `"down"` for a loss. */
  direction: "up" | "down";
  /** The movement in the reporting currency (mvToday - baseline - flow). */
  movementValue: number;
  /**
   * The three components the movement is the difference of, carried so a reader
   * can reproduce the figure rather than take it on trust: the value the period
   * opened at, the value it closed at, and the external cash removed from the
   * difference. All in the reporting currency, at money precision.
   */
  baselineValue: number;
  currentValue: number;
  externalFlow: number;
}

export interface MovementDecision {
  /** The alert to raise, or null (silent, withheld, or nothing to compare). */
  fire: FiredMovement | null;
  /**
   * The value to store as the new baseline, or null to leave the baseline
   * untouched. Null means the run was a no-op (incomplete value or flow): a
   * subtotal must never become a baseline (INV-PORTMOVE-001).
   */
  rebaselineTo: number | null;
}

const roundPercent = (value: number): number => {
  const factor = 10 ** PORTFOLIO_MOVE_PERCENT_DECIMALS;
  return Math.round(value * factor) / factor;
};

/**
 * Decide the movement outcome. The order of the guards is the spec's:
 *
 * 1. Value incomplete -> no-op (no alert, no rebaseline): a subtotal is unknown.
 * 2. Off (no threshold) -> no-op: nothing to maintain a baseline for.
 * 3. No baseline, a reporting-currency change, or a baseline with no capture
 *    date -> rebaseline, no alert: an undated baseline names no period, so the
 *    flow and the price-freshness evidence below have nothing to span.
 * 4. Flow incomplete -> no-op: an unconvertible contribution makes the movement
 *    unknown; do not rebaseline on an unknown run either.
 * 5. A held position priced before the baseline date -> no-op: today's value is
 *    partly carried evidence, so the difference is not a market move
 *    (INV-PORTMOVE-008). Checked after the baseline exists, because "older than
 *    the baseline" has no meaning before there is one.
 * 6. Baseline value 0 -> undefined percentage -> rebaseline, no alert.
 * 7. Otherwise compute movement = mvToday - baseline - flow, compare
 *    |movement / baseline| against the threshold (at full precision), and
 *    rebaseline to today whether or not it fired.
 */
export function decideMovement(input: MovementInputs): MovementDecision {
  if (!input.mvComplete) return { fire: null, rebaselineTo: null };
  if (input.movePercent == null || input.movePercent <= 0) {
    return { fire: null, rebaselineTo: null };
  }
  if (
    input.baseline == null ||
    input.baseline.currency !== input.currency ||
    !input.baselineDateKnown
  ) {
    return { fire: null, rebaselineTo: input.mvToday };
  }
  if (!input.flow.complete) return { fire: null, rebaselineTo: null };
  if (!input.pricesCurrentSinceBaseline) {
    return { fire: null, rebaselineTo: null };
  }
  if (input.baseline.value === 0) {
    return { fire: null, rebaselineTo: input.mvToday };
  }

  // The threshold compares at full precision, but the STORED movement is the
  // difference of three decimal(20,4) values, and the difference of two 4dp
  // decimals is not a 4dp decimal -- round the delta before it is persisted.
  const movement = input.mvToday - input.baseline.value - input.flow.value;
  const rawPercent = (movement / input.baseline.value) * 100;
  const fires = Math.abs(rawPercent) >= input.movePercent;
  return {
    fire: fires
      ? {
          changePercent: roundPercent(rawPercent),
          direction: rawPercent >= 0 ? "up" : "down",
          movementValue: roundMoney(movement),
          baselineValue: roundMoney(input.baseline.value),
          currentValue: roundMoney(input.mvToday),
          externalFlow: roundMoney(input.flow.value),
        }
      : null,
    rebaselineTo: input.mvToday,
  };
}
