import { roundMoney, roundToDecimals } from "../common/round.util";
import { PORTFOLIO_MOVE_PERCENT_DECIMALS } from "../notification-center/portfolio-movement.util";

/**
 * Why a period's result could not be reported, as a closed set so a client
 * renders actionable copy instead of parsing prose.
 *
 * The distinctions are the repairs: a price is entered against the security, a
 * rate in Currencies, a cash account with no balance for a day it was asked for
 * is a defect to report. `zeroStart` is none of those -- the money figures are
 * known and only the ratio is undefined.
 */
export type PeriodResultReason =
  /** The scope produced no value series for the window at all. */
  | "noValueSeries"
  /** A boundary day held a position with no accepted close on or before it. */
  | "incompletePrices"
  /** A boundary day had a scoped cash account with no balance for it. */
  | "incompleteCash"
  /** A boundary value or a flow could not be converted; see missingRatePairs. */
  | "missingRatePairs"
  /**
   * The starting value is not positive: a percentage of nothing, and a ratio
   * over a negative base reverses its own sign. The money figures still stand.
   */
  | "zeroStart";

/**
 * How `returnPercent` was arrived at, named on the wire.
 *
 * `simple` divides the whole period's result by the value it started with. It
 * ignores WHEN a flow arrived, so it understates a period whose money arrived
 * late and overstates one whose money arrived early. The union exists so a
 * time-weighted figure later becomes a new member rather than a silent change of
 * meaning under the same caption: adding `"modifiedDietz"` or `"twr"` here is a
 * compile error at every consumer that switched on the method, which is the
 * point. Neither is claimed today, because both need a complete value on every
 * flow date rather than only at the two boundaries
 * (`docs/specs/portfolio-period-result.md` section 2.1).
 */
export type PeriodReturnMethod = "simple";

/** One boundary of the period, as `getDailyInvestments` reports that day. */
export interface PeriodBoundaryValue {
  date: string;
  /** The day's value. A SUBTOTAL whenever a completeness bit is false. */
  value: number;
  fxComplete?: boolean;
  pricesComplete?: boolean;
  cashComplete?: boolean;
  missingRatePairs?: string[];
  unpricedSecurityIds?: string[];
  unknownCashAccountIds?: string[];
}

/** The period's external cash flow, already folded into one currency. */
export interface PeriodFlow {
  /** False when a subtotal could not be converted. */
  complete: boolean;
  /** The net flow in the reporting currency; a subtotal when incomplete. */
  value: number;
  /** `"EUR->USD"` for each pair with no rate on its day. */
  missingPairs: string[];
}

export interface PeriodResultInput {
  /** MV(b): the close the period is measured from; null when there is none. */
  start: PeriodBoundaryValue | null;
  /** MV(e): the close the period is measured to; null when there is none. */
  end: PeriodBoundaryValue | null;
  flow: PeriodFlow;
}

export interface PeriodResultDecision {
  /** MV(b); null when that boundary is a subtotal. */
  startValue: number | null;
  /** MV(e); null when that boundary is a subtotal. */
  endValue: number | null;
  /** `MV(e) - MV(b)`: what the portfolio is worth now, less what it was. */
  valueChange: number | null;
  /** Cash that crossed the scope's boundary on `(b, e]`, net. */
  netExternalFlows: number | null;
  /** What DID convert, when `netExternalFlows` is withheld. Never a total. */
  knownFlowSubtotal: number;
  /** `valueChange - netExternalFlows`: what the market did, and nothing else. */
  investmentResult: number | null;
  /** The result over the starting value; see `returnMethod`. */
  returnPercent: number | null;
  returnMethod: PeriodReturnMethod;
  /** True only when every figure above is known, the percentage included. */
  complete: boolean;
  reasons: PeriodResultReason[];
  /** Every pair, from either boundary or from the flow, with no rate. */
  missingRatePairs: string[];
  /** Securities behind an `incompletePrices` boundary. */
  unpricedSecurityIds: string[];
  /** Accounts behind an `incompleteCash` boundary. */
  unknownCashAccountIds: string[];
}

/**
 * What a portfolio did over a period, net of the reader's own contributions.
 *
 * The measure is the one the daily notification already settled on
 * (`docs/specs/portfolio-movement-notifications.md` section 2), asked over a
 * window rather than a day: a deposit raises the value without the market having
 * moved, so it is removed; a dividend, a buy and a sell are internal to the
 * scope and are kept, because they are return.
 *
 * Each guard below removes one way the figures can fail to hold, in the order of
 * the truth table in `docs/specs/portfolio-period-result.md` section 4:
 *
 * 1. No series -> nothing is known. A scope with no valued day has no change.
 * 2. A boundary that is a subtotal -> no `valueChange`, carrying that day's own
 *    causes. A subtotal minus a total is not a difference.
 * 3. A flow that did not fully convert -> no `netExternalFlows` and therefore no
 *    result, with the pairs named. Dropping the currency that would not convert
 *    reports the reader's own deposit as a gain, which is the whole defect
 *    (INV-PORTRESULT-003).
 * 4. A zero starting value -> the money is known, the ratio is not.
 *
 * Pure, so the whole policy is table-tested without a database, and so no
 * consumer re-derives a row of it.
 */
export function decidePeriodResult(
  input: PeriodResultInput,
): PeriodResultDecision {
  const { start, end, flow } = input;

  const missingRatePairs = new Set<string>(flow.missingPairs);
  const unpricedSecurityIds = new Set<string>();
  const unknownCashAccountIds = new Set<string>();
  const reasons = new Set<PeriodResultReason>();

  for (const boundary of [start, end]) {
    if (!boundary) continue;
    for (const pair of boundary.missingRatePairs ?? []) {
      missingRatePairs.add(pair);
    }
    for (const id of boundary.unpricedSecurityIds ?? []) {
      unpricedSecurityIds.add(id);
    }
    for (const id of boundary.unknownCashAccountIds ?? []) {
      unknownCashAccountIds.add(id);
    }
  }

  // The flow is a subtotal the moment one currency has no rate for its day; the
  // partial sum travels under its own name and never under the total's.
  const netExternalFlows = flow.complete ? roundMoney(flow.value) : null;
  if (!flow.complete) reasons.add("missingRatePairs");

  const base: Omit<
    PeriodResultDecision,
    "startValue" | "endValue" | "valueChange" | "investmentResult"
  > = {
    netExternalFlows,
    knownFlowSubtotal: roundMoney(flow.value),
    returnPercent: null,
    returnMethod: "simple",
    complete: false,
    reasons: [],
    missingRatePairs: [...missingRatePairs].sort(),
    unpricedSecurityIds: [...unpricedSecurityIds].sort(),
    unknownCashAccountIds: [...unknownCashAccountIds].sort(),
  };

  if (start === null || end === null) {
    reasons.add("noValueSeries");
    return {
      ...base,
      startValue: null,
      endValue: null,
      valueChange: null,
      investmentResult: null,
      reasons: [...reasons],
    };
  }

  // `=== false`, never `!flag`: an absent bit is an older producer saying
  // nothing, which is no information rather than a claim of incompleteness.
  const boundaryComplete = (point: PeriodBoundaryValue) =>
    point.fxComplete !== false &&
    point.pricesComplete !== false &&
    point.cashComplete !== false;

  for (const boundary of [start, end]) {
    if (boundaryComplete(boundary)) continue;
    if (boundary.pricesComplete === false) reasons.add("incompletePrices");
    if (boundary.cashComplete === false) reasons.add("incompleteCash");
    if (boundary.fxComplete === false) reasons.add("missingRatePairs");
  }

  if (!boundaryComplete(start) || !boundaryComplete(end)) {
    return {
      ...base,
      startValue: boundaryComplete(start) ? start.value : null,
      endValue: boundaryComplete(end) ? end.value : null,
      valueChange: null,
      investmentResult: null,
      reasons: [...reasons],
    };
  }

  // A difference of two decimal(20,4) values is rounded once here rather than
  // accumulating drift through the two figures derived from it.
  const valueChange = roundMoney(end.value - start.value);
  const investmentResult =
    netExternalFlows === null
      ? null
      : roundMoney(valueChange - netExternalFlows);

  if (investmentResult === null) {
    return {
      ...base,
      startValue: start.value,
      endValue: end.value,
      valueChange,
      investmentResult: null,
      reasons: [...reasons],
    };
  }

  if (!(start.value > 0)) {
    // A move away from nothing has no percentage, and 0% would report the
    // opposite of what happened. The money figures are still known.
    reasons.add("zeroStart");
    return {
      ...base,
      startValue: start.value,
      endValue: end.value,
      valueChange,
      investmentResult,
      reasons: [...reasons],
    };
  }

  return {
    ...base,
    startValue: start.value,
    endValue: end.value,
    valueChange,
    investmentResult,
    // A percentage is a ratio, not money: PORTFOLIO_MOVE_PERCENT_DECIMALS,
    // never roundMoney.
    returnPercent: roundToDecimals(
      (investmentResult / start.value) * 100,
      PORTFOLIO_MOVE_PERCENT_DECIMALS,
    ),
    complete: true,
    reasons: [],
  };
}
