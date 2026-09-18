/**
 * What the INVESTED part of a portfolio earned over a period, and at what rate.
 *
 * The sibling of `decidePeriodResult`, over the same series and the same
 * window, asking the question a reader hears under the caption "Portfolio
 * performance": how much did my INVESTMENTS earn or lose, not how much did the
 * whole investment account move including the cash I paid into it. Cash held in
 * an investment account is not an investment, so it is in neither figure and in
 * neither the numerator nor the base of the percentage: paying it in or out
 * moves neither (INV-PORTRESULT-002,
 * `docs/specs/portfolio-period-result.md` section 10).
 *
 * Pure, so the whole policy is table-tested without a database -- the spec's
 * twelve worked cases are `invested-period-result.util.spec.ts` -- and so
 * neither the single-range route nor the batch route re-derives a row of it.
 */
import { roundMoney, roundToDecimals } from "../common/round.util";
import {
  chainTwrPercent,
  subPeriodFactor,
} from "../common/time-series/twr-chain.util";
import { PORTFOLIO_MOVE_PERCENT_DECIMALS } from "../notification-center/portfolio-movement.util";
import {
  EMPTY_INVESTED_FLOW_DAY,
  InvestedFlowDay,
} from "./invested-capital-flow.util";
import {
  PeriodResultReason,
  UnmeasuredFlowCounts,
} from "./portfolio-period-result.util";

/**
 * How `investmentReturnPercent` was arrived at, named on the wire so a later
 * method is a new union member rather than a silent change of meaning under the
 * same caption -- the reason `PeriodReturnMethod` names `simple`.
 */
export type InvestedReturnMethod = "twr";

/** One day of the value series, as the invested measure reads it. */
export interface InvestedDayValue {
  date: string;
  /** `IV(t)`: the securities at that close, no cash. A subtotal when a bit is false. */
  securitiesValue: number;
  fxComplete?: boolean;
  pricesComplete?: boolean;
  missingRatePairs?: string[];
  unpricedSecurityIds?: string[];
}

export interface InvestedPeriodInput {
  /** The contiguous daily series the window is sliced out of. */
  points: readonly InvestedDayValue[];
  /** Index of `b`: the close the period is measured FROM. */
  startIndex: number;
  /** Index of `e`: the close it is measured TO. */
  endIndex: number;
  /** The invested part's capital and income, per day, already in the currency. */
  flowsByDay: ReadonlyMap<string, InvestedFlowDay>;
  /** Absent means the caller counted none, not that none exist. */
  unmeasuredFlows?: UnmeasuredFlowCounts;
}

export interface InvestedPeriodDecision {
  /** `IV(b)`; null when that day is a subtotal. */
  investedValueStart: number | null;
  /** `IV(e)`; null when that day is a subtotal. */
  investedValueEnd: number | null;
  /** Net value paid into the invested part on `(b, e]`: buys less disposals. */
  investmentCapitalFlows: number | null;
  /** Dividends, interest and capital-gain distributions received on `(b, e]`. */
  investmentIncome: number | null;
  /** `IV(e) - IV(b) - capital + income`: what the investments earned. */
  investmentPnl: number | null;
  /** The time-weighted return over the same days; see `investmentReturnMethod`. */
  investmentReturnPercent: number | null;
  investmentReturnMethod: InvestedReturnMethod;
  /** True only when both figures above are known. */
  investedComplete: boolean;
  /** Why a figure is withheld, from the same closed set the account measure uses. */
  investedReasons: PeriodResultReason[];
}

const WITHHELD: Omit<
  InvestedPeriodDecision,
  "investedReasons" | "investmentCapitalFlows" | "investmentIncome"
> = {
  investedValueStart: null,
  investedValueEnd: null,
  investmentPnl: null,
  investmentReturnPercent: null,
  investmentReturnMethod: "twr",
  investedComplete: false,
};

/**
 * `=== false`, never `!flag`: an absent bit is an older producer saying nothing,
 * which is no information rather than a claim of incompleteness.
 *
 * `cashComplete` is deliberately not among them. No cash is in `IV`, so a cash
 * account with no balance for a day cannot make these figures wrong; it still
 * withholds the account-level `valueChange` and is still reported to the reader.
 */
function pointComplete(point: InvestedDayValue): boolean {
  return point.fxComplete !== false && point.pricesComplete !== false;
}

/**
 * The invested part's result for one window of one series.
 *
 * The guards run in the order of the truth table in section 10.4:
 *
 * 1. No window -> nothing is known.
 * 2. A day the CHAIN SPANS that is a subtotal -> no figures, carrying that
 *    day's own causes. A factor chained over a subtotal is a return on a
 *    portfolio nobody owns, which is the rule `calculateTWR` already keeps for
 *    its own FX gaps -- and unlike a value difference, a chain cannot be
 *    repaired at the two ends.
 * 3. A capital or income row that did not convert -> no figures, pairs named.
 * 4. A movement the flow classifier cannot count -> no figures, cause named.
 * 5. A window in which nothing was ever invested -> a known zero when nothing
 *    was earned either, and no ratio otherwise.
 */
export function investedPeriodResult(
  input: InvestedPeriodInput,
): InvestedPeriodDecision {
  const { points, startIndex, endIndex, flowsByDay } = input;

  if (
    points.length === 0 ||
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex >= points.length
  ) {
    return {
      ...WITHHELD,
      investmentCapitalFlows: null,
      investmentIncome: null,
      investedReasons: ["noValueSeries"],
    };
  }

  const reasons = new Set<PeriodResultReason>();

  // The days the chain spans, and the flows that land on them. `(b, e]`: IV(b)
  // is a close and already holds everything dated b, so counting those rows
  // again would subtract them from a value that holds them.
  const days = points.slice(startIndex + 1, endIndex + 1);
  const flowDays = days.map(
    (point) => flowsByDay.get(point.date) ?? EMPTY_INVESTED_FLOW_DAY,
  );

  // Money is accumulated in integer ten-thousandths and divided once, never
  // summed as floats (AGENTS.md, Financial math).
  let capitalMinor = 0;
  let incomeMinor = 0;
  let flowsComplete = true;
  for (const day of flowDays) {
    capitalMinor += Math.round((day.capitalIn - day.capitalOut) * 10000);
    incomeMinor += Math.round(day.income * 10000);
    if (!day.complete) {
      flowsComplete = false;
      reasons.add("missingRatePairs");
    }
  }
  const investmentCapitalFlows = flowsComplete
    ? roundMoney(capitalMinor / 10000)
    : null;
  const investmentIncome = flowsComplete
    ? roundMoney(incomeMinor / 10000)
    : null;

  for (const point of [points[startIndex], ...days]) {
    if (pointComplete(point)) continue;
    if (point.pricesComplete === false) reasons.add("incompletePrices");
    if (point.fxComplete === false) reasons.add("missingRatePairs");
  }

  const unmeasured = input.unmeasuredFlows;
  if ((unmeasured?.externallySettledTrades ?? 0) > 0) {
    reasons.add("externallySettledTrade");
  }
  if ((unmeasured?.mixedSplitParents ?? 0) > 0) reasons.add("mixedSplit");

  const withheld = (): InvestedPeriodDecision => ({
    ...WITHHELD,
    investmentCapitalFlows,
    investmentIncome,
    investedReasons: [...reasons],
  });

  if (reasons.size > 0) return withheld();

  const start = points[startIndex];
  const end = points[endIndex];

  const pnl = roundMoney(
    (Math.round(end.securitiesValue * 10000) -
      Math.round(start.securitiesValue * 10000) -
      capitalMinor +
      incomeMinor) /
      10000,
  );

  // A purchase is funded at the START of the day, so buying cannot be a gain;
  // a disposal and a distribution leave at the END of it, so selling cannot be
  // a loss. Section 10.2 derives the split convention: a single start-of-day
  // convention makes a profitable full sale's base negative and drops the day
  // that realised the whole gain out of the chain.
  const factors: number[] = [];
  let anyBase = false;
  for (let i = 0; i < days.length; i++) {
    const previous =
      i === 0 ? start.securitiesValue : days[i - 1].securitiesValue;
    const flow = flowDays[i];
    const base = previous + flow.capitalIn;
    const ending = days[i].securitiesValue + flow.capitalOut + flow.income;
    const factor = subPeriodFactor(base, ending);
    if (factor === null) continue;
    anyBase = true;
    factors.push(factor);
  }

  if (!anyBase) {
    // No day of the window had capital at risk. Nothing invested and nothing
    // earned is a KNOWN zero (the spec's case 1); a result with no invested
    // capital behind it has no ratio at all.
    if (pnl === 0) {
      return {
        investedValueStart: start.securitiesValue,
        investedValueEnd: end.securitiesValue,
        investmentCapitalFlows,
        investmentIncome,
        investmentPnl: 0,
        investmentReturnPercent: 0,
        investmentReturnMethod: "twr",
        investedComplete: true,
        investedReasons: [],
      };
    }
    reasons.add("zeroStart");
    return {
      ...WITHHELD,
      investedValueStart: start.securitiesValue,
      investedValueEnd: end.securitiesValue,
      investmentCapitalFlows,
      investmentIncome,
      investmentPnl: pnl,
      investedReasons: [...reasons],
    };
  }

  const percent = chainTwrPercent(factors);
  if (percent === null) {
    reasons.add("zeroStart");
    return {
      ...WITHHELD,
      investedValueStart: start.securitiesValue,
      investedValueEnd: end.securitiesValue,
      investmentCapitalFlows,
      investmentIncome,
      investmentPnl: pnl,
      investedReasons: [...reasons],
    };
  }

  return {
    investedValueStart: start.securitiesValue,
    investedValueEnd: end.securitiesValue,
    investmentCapitalFlows,
    investmentIncome,
    investmentPnl: pnl,
    // A percentage is a ratio, not money: PORTFOLIO_MOVE_PERCENT_DECIMALS,
    // never roundMoney.
    investmentReturnPercent: roundToDecimals(
      percent,
      PORTFOLIO_MOVE_PERCENT_DECIMALS,
    ),
    investmentReturnMethod: "twr",
    investedComplete: true,
    investedReasons: [],
  };
}

/** The answer for a scope or window with no series at all. */
export const NO_INVESTED_PERIOD: InvestedPeriodDecision = {
  ...WITHHELD,
  investmentCapitalFlows: null,
  investmentIncome: null,
  investedReasons: ["noValueSeries"],
};
