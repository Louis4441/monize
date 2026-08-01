import { roundToDecimals } from "../common/round.util";
import {
  GemAssetRole,
  GEM_EQUITY_ROLES,
} from "./entities/gem-strategy-asset.entity";
import {
  GemMomentumSnapshot,
  GemSignalState,
} from "./entities/gem-strategy-signal.entity";
import { GemCadence } from "./entities/gem-strategy.entity";

/**
 * Pure GEM (Global Equities Momentum) arithmetic: evaluation calendar, trailing
 * momentum, and the two decision steps. No database, no clock beyond the date
 * handed in -- so the rules are testable in isolation and the services stay
 * about data access.
 *
 * The rules implemented here are the standard dual-momentum ones:
 *   1. Absolute momentum -- compare the US equity leg's trailing return with
 *      the risk-free leg's (`RISK_FREE`, T-bills in the original rules).
 *      Equities win => RISK_ON, otherwise RISK_OFF and the portfolio moves into
 *      the `SAFE` instrument, which is a different asset: the yardstick and the
 *      thing you hold need not be the same fund.
 *   2. Relative momentum -- while RISK_ON, hold the equity market with the
 *      strongest trailing return. While RISK_OFF the ranking is not consulted.
 * The portfolio is always 100% in a single asset.
 */

/** A price point, as stored: an ISO date and its close. */
export interface PricePoint {
  date: string;
  close: number;
}

/** One evaluation period on the strategy's calendar. */
export interface GemPeriod {
  /** Price date the decision is taken on (the day before the period starts). */
  evaluatedOn: string;
  /** First day the resulting allocation applies. */
  effectiveFrom: string;
}

/** Percentage points, rounded the way every momentum figure is. */
export const GEM_PP_DECIMALS = 4;

function ymd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse an ISO date (date-only) as UTC midnight, avoiding local-timezone drift. */
export function parseYmd(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** First day of the month `value` falls in. */
function startOfMonthUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/** Shift a date by whole months, clamping to the target month's last day. */
export function addMonthsUtc(value: Date, months: number): Date {
  const target = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return target;
}

/** Months between one period start and the next, for the given cadence. */
export function cadenceMonths(cadence: GemCadence): number {
  return cadence === "QUARTERLY" ? 3 : 1;
}

/**
 * The period `asOf` falls in. A monthly strategy re-allocates on the 1st of
 * every month; a quarterly one on the 1st of January, April, July and October.
 * The decision uses prices from the last day before the period starts, which is
 * how a month-end signal becomes a first-of-month allocation.
 */
export function periodFor(asOf: string, cadence: GemCadence): GemPeriod {
  const step = cadenceMonths(cadence);
  const date = parseYmd(asOf);
  const monthStart = startOfMonthUtc(date);
  // Align the period start to the cadence grid (quarterly => Jan/Apr/Jul/Oct).
  const alignedMonth = Math.floor(monthStart.getUTCMonth() / step) * step;
  const effectiveFrom = new Date(
    Date.UTC(monthStart.getUTCFullYear(), alignedMonth, 1),
  );
  const evaluatedOn = new Date(effectiveFrom);
  evaluatedOn.setUTCDate(0); // last day of the previous month
  return { evaluatedOn: ymd(evaluatedOn), effectiveFrom: ymd(effectiveFrom) };
}

/**
 * The `count` most recent periods up to and including the one `asOf` falls in,
 * oldest first. Used to backfill history the first time a strategy is read.
 */
export function recentPeriods(
  asOf: string,
  cadence: GemCadence,
  count: number,
): GemPeriod[] {
  if (count <= 0) return [];
  const step = cadenceMonths(cadence);
  const current = periodFor(asOf, cadence);
  const periods: GemPeriod[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const effectiveFrom = addMonthsUtc(
      parseYmd(current.effectiveFrom),
      -i * step,
    );
    const evaluatedOn = new Date(effectiveFrom);
    evaluatedOn.setUTCDate(0);
    periods.push({
      evaluatedOn: ymd(evaluatedOn),
      effectiveFrom: ymd(effectiveFrom),
    });
  }
  return periods;
}

/**
 * Close price on `date`, or the most recent one before it. Prices are expected
 * sorted oldest-first; the lookup is a binary search so a multi-year series can
 * be probed once per period without rescanning.
 *
 * Returns null when the series starts after `date` -- an unknown price, never a
 * substituted zero.
 */
export function priceAsOf(prices: PricePoint[], date: string): number | null {
  let low = 0;
  let high = prices.length - 1;
  let found: number | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (prices[mid].date <= date) {
      found = prices[mid].close;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Trailing total return between two dates, in percent. Null when either price
 * is missing or the base is not positive (a zero base would produce Infinity).
 */
export function trailingReturnPercent(
  prices: PricePoint[],
  from: string,
  to: string,
): number | null {
  const base = priceAsOf(prices, from);
  const latest = priceAsOf(prices, to);
  if (base === null || latest === null || base <= 0) return null;
  return roundToDecimals((latest / base - 1) * 100, GEM_PP_DECIMALS);
}

/**
 * Momentum per role over the lookback window ending at `evaluatedOn`. A role
 * with no instrument, or with prices that do not cover the window, comes back
 * null so every caller renders it as unknown.
 */
export function momentumSnapshot(
  pricesByRole: Partial<Record<GemAssetRole, PricePoint[]>>,
  evaluatedOn: string,
  lookbackMonths: number,
): GemMomentumSnapshot {
  const from = ymd(addMonthsUtc(parseYmd(evaluatedOn), -lookbackMonths));
  const snapshot: GemMomentumSnapshot = {};
  for (const [role, prices] of Object.entries(pricesByRole) as Array<
    [GemAssetRole, PricePoint[]]
  >) {
    snapshot[role] = prices?.length
      ? trailingReturnPercent(prices, from, evaluatedOn)
      : null;
  }
  return snapshot;
}

/** A role and its momentum, ordered best-first by `rankEquities`. */
export interface RankedRole {
  role: GemAssetRole;
  momentum: number;
}

/**
 * Equity roles with a known momentum, strongest first. Roles without momentum
 * are dropped rather than sorted to the bottom: an unknown figure cannot be
 * said to be worse than a known one.
 *
 * Ties break on the canonical role order, so a tie produces the same winner on
 * every evaluation instead of depending on object key order.
 */
export function rankEquities(
  momentum: GemMomentumSnapshot,
  eligibleRoles: readonly GemAssetRole[] = GEM_EQUITY_ROLES,
): RankedRole[] {
  return GEM_EQUITY_ROLES.filter(
    (role) =>
      eligibleRoles.includes(role) &&
      typeof momentum[role] === "number" &&
      Number.isFinite(momentum[role]),
  )
    .map((role) => ({ role, momentum: momentum[role] as number }))
    .sort((a, b) => b.momentum - a.momentum);
}

/**
 * Which instrument the absolute test measures equities against: the dedicated
 * risk-free leg when one is assigned, otherwise the safe asset. The fallback is
 * what keeps a strategy configured before the two roles were split evaluating
 * exactly as it did.
 */
export function benchmarkRoleFor(
  mappedRoles: readonly GemAssetRole[],
): GemAssetRole {
  return mappedRoles.includes("RISK_FREE") ? "RISK_FREE" : "SAFE";
}

/**
 * Which instrument a RISK-OFF period moves into: the safe asset, unless the
 * risk-free leg is the only defensive instrument assigned. Holding the yardstick
 * is a reasonable last resort; holding nothing is not. With neither assigned the
 * answer is still `SAFE` -- the role the report then reports as unmapped.
 */
export function riskOffRoleFor(
  mappedRoles: readonly GemAssetRole[],
): GemAssetRole {
  return mappedRoles.includes("RISK_FREE") && !mappedRoles.includes("SAFE")
    ? "RISK_FREE"
    : "SAFE";
}

/** The outcome of one evaluation, before it is persisted. */
export interface GemEvaluation {
  state: GemSignalState;
  /** Role to hold: the equity winner while RISK_ON, the safe asset otherwise. */
  targetRole: GemAssetRole | null;
  /** The role the absolute test compared equities against. */
  benchmarkRole: GemAssetRole;
  /** US equity momentum minus benchmark momentum, in pp. */
  spreadPp: number | null;
  /** Winner minus runner-up, in pp. Null while RISK_OFF or with one candidate. */
  leadPp: number | null;
  ranking: RankedRole[];
}

/**
 * Run both decision steps. Returns null when the absolute test cannot be run at
 * all -- momentum missing for the US equity leg or for the benchmark -- because
 * guessing a state from half the inputs would produce a signal the user could
 * act on with no basis.
 *
 * `mappedRoles` are the roles with an instrument assigned; they decide both
 * which equity markets the ranking considers and which instrument stands in as
 * the risk-free benchmark.
 */
export function evaluate(
  momentum: GemMomentumSnapshot,
  mappedRoles: readonly GemAssetRole[] = GEM_EQUITY_ROLES,
): GemEvaluation | null {
  const benchmarkRole = benchmarkRoleFor(mappedRoles);
  const equity = momentum.US_EQUITY;
  const benchmark = momentum[benchmarkRole];
  if (
    typeof equity !== "number" ||
    typeof benchmark !== "number" ||
    !Number.isFinite(equity) ||
    !Number.isFinite(benchmark)
  ) {
    return null;
  }

  const spreadPp = roundToDecimals(equity - benchmark, GEM_PP_DECIMALS);
  const ranking = rankEquities(momentum, mappedRoles);
  const riskOn = equity > benchmark;

  if (!riskOn) {
    return {
      state: "RISK_OFF",
      targetRole: riskOffRoleFor(mappedRoles),
      benchmarkRole,
      spreadPp,
      leadPp: null,
      ranking,
    };
  }

  const winner = ranking[0] ?? null;
  const runnerUp = ranking[1] ?? null;
  return {
    state: "RISK_ON",
    benchmarkRole,
    // With no eligible equity instrument there is nothing to hold; the report
    // reports the unmapped roles rather than falling back to the safe asset,
    // which would be a different signal than the rules produce.
    targetRole: winner ? winner.role : null,
    spreadPp,
    leadPp:
      winner && runnerUp
        ? roundToDecimals(winner.momentum - runnerUp.momentum, GEM_PP_DECIMALS)
        : null,
    ranking,
  };
}

/** What a stored evaluation asked the investor to do. */
export type GemHistoryAction = "BUY" | "HOLD" | "SWITCH";

/**
 * The action a period implies: the first allocation is a BUY, a change of
 * instrument a SWITCH, and an unchanged allocation a HOLD.
 */
export function historyAction(
  targetRole: GemAssetRole | null,
  previousRole: GemAssetRole | null,
): GemHistoryAction {
  if (!previousRole) return "BUY";
  if (targetRole && targetRole !== previousRole) return "SWITCH";
  return "HOLD";
}
