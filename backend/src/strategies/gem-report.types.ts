import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import {
  GemCompositionBasis,
  GemCompositionDimension,
} from "./gem-composition.util";
import {
  GemMomentumSnapshot,
  GemSignalState,
} from "./entities/gem-strategy-signal.entity";
import { GemCadence } from "./entities/gem-strategy.entity";
import { GemHistoryAction } from "./gem-momentum.util";

/**
 * The GEM report read model returned by GET /strategies/gem/report. Mirrors
 * `frontend/src/types/gem-strategy.ts` field for field -- one server-side model
 * so the client renders the strategy without recomputing any of it.
 *
 * `null` always means "not known": an unmapped role, missing price history, no
 * strategy account, or a value that could not be estimated. Callers render an
 * explicit unknown marker for those, never a zero.
 */

/** Selectable window for the asset-performance chart. */
export const GEM_RANGES = ["3M", "6M", "1Y", "3Y", "5Y", "MAX"] as const;

export type GemRange = (typeof GEM_RANGES)[number];

export type GemWarningCode =
  | "UNMAPPED_ROLE"
  | "INCOMPLETE_HISTORY"
  /**
   * Periods decided under an earlier configuration of this strategy are not in
   * the history or the backtest, because the current one cannot recalculate
   * them. Everything shown comes from one configuration; this says what that
   * cost, rather than letting the history quietly come up short.
   */
  | "LEGACY_PERIODS"
  | "NO_ACCOUNT"
  | "NO_POSITION"
  | "FIRST_RUN"
  | "STALE_PRICES"
  | "CALCULATION_FAILED";

export interface GemWarning {
  code: GemWarningCode;
  roles?: GemAssetRole[];
  /** How many things the warning is about, when the number is the point. */
  count?: number;
}

export interface GemAssetRef {
  role: GemAssetRole;
  securityId: string | null;
  symbol: string | null;
  name: string | null;
}

export interface GemAssetMomentum extends GemAssetRef {
  momentum12m: number | null;
  rank: number | null;
}

/**
 * An instrument actually held in the strategy accounts. `role` is null for a
 * holding that fills no strategy role: the comparison covers the whole
 * portfolio, so those count towards the total and towards what a switch moves.
 */
export interface GemHeldAsset {
  role: GemAssetRole | null;
  /**
   * True for the accounts' cash balance, which is a position for compliance
   * purposes -- GEM wants everything in one instrument, so idle cash is as
   * off-target as the wrong fund -- but has no security to link to and is
   * spent rather than sold.
   */
  isCash: boolean;
  securityId: string | null;
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  marketValue: number | null;
  /**
   * Share of this holding already in the target's markets, 0-100. A world
   * tracker partly covers an emerging-markets target; only the rest moves.
   */
  matchPercent: number | null;
  /** True when the ticker decided it, because no breakdown was available. */
  matchedByInstrument: boolean;
  /**
   * Which of the target's markets this holding covers, largest first, as
   * percentages of the holding. A compliance figure says a fifth of a fund is
   * on target; this says which fifth.
   */
  matchedMarkets: Array<{ name: string; percent: number }>;
}

export interface GemAbsoluteStep {
  equity: GemAssetMomentum;
  /**
   * What equities were measured against. The dedicated risk-free leg when one
   * is assigned, otherwise the safe asset -- and it names the role, because a
   * stored evaluation keeps the benchmark it was actually taken with.
   */
  benchmark: GemAssetMomentum;
  spreadPp: number | null;
  result: GemSignalState;
}

export interface GemRelativeStep {
  ranking: GemAssetMomentum[];
  winner: GemAssetRef | null;
  leadPp: number | null;
  applied: boolean;
}

export interface GemSignalView {
  id: string;
  state: GemSignalState;
  target: GemAssetRef | null;
  targetWeightPercent: number;
  effectiveFrom: string;
  evaluatedOn: string;
  absolute: GemAbsoluteStep;
  relative: GemRelativeStep;
}

export interface GemAccountRef {
  id: string;
  name: string;
}

export interface GemPositionView {
  /** Accounts the strategy is run in; their holdings are summed. */
  accounts: GemAccountRef[];
  /** Everything held in those accounts, largest position first. */
  holdings: GemHeldAsset[];
  /** The largest holding -- what the accounts are effectively in. */
  current: GemHeldAsset | null;
  target: GemAssetRef | null;
  /** Share of the accounts' whole market value already in the target, 0-100. */
  compliancePercent: number | null;
  changeRequired: boolean;
  /** Market value of everything held in the accounts, in `currencyCode`. */
  totalMarketValue: number | null;
  /**
   * Whether compliance was measured against what the instruments contain or
   * against their tickers. `INSTRUMENT` means the target carries no breakdown
   * to compare with, which the report says out loud rather than implying the
   * weaker comparison is the intended one.
   */
  basis: GemCompositionBasis;
  /** Breakdown the contents were compared on; null when tickers were used. */
  dimension: GemCompositionDimension | null;
  /**
   * The breakdown the target would need for a contents comparison of this
   * role. Naming it is the difference between "fill something in" and "fill in
   * the country split", which for an equity role is the only one that helps.
   */
  requiredDimension: GemCompositionDimension | null;
  /** How many holdings fell back to a ticker comparison. */
  instrumentMatchedCount: number;
  currencyCode: string;
}

export interface GemActionView {
  required: boolean;
  /** Largest holding the switch sells out of. */
  from: GemHeldAsset | null;
  /** How many instruments the switch sells out of, `from` included. */
  fromCount: number;
  to: GemAssetRef | null;
  targetWeightPercent: number;
  transferValue: number | null;
  realizedGainLoss: number | null;
  estimatedTax: number | null;
  taxRatePercent: number | null;
  estimatedCommission: number | null;
  /** Trades the switch takes: one sell per off-target holding, plus the buy. */
  estimatedTradeCount: number;
  /**
   * How many of the sold holdings were partly in the target's markets already.
   * Those count towards compliance but are still sold whole, and a transfer
   * larger than "everything off target" needs that said rather than inferred.
   */
  partialMatchCount: number;
  accounts: GemAccountRef[];
  currencyCode: string;
  executed: boolean;
}

export interface GemPerformancePoint {
  date: string;
  values: Partial<Record<GemAssetRole, number | null>>;
}

/**
 * The asset comparison, as cumulative percentage returns rebased to zero at the
 * window start. There is no currency here on purpose: the lines are computed
 * from each instrument's own listing-currency closes, which is the same basis
 * the momentum behind the signal is measured on. Converting them would make the
 * chart disagree with the signal it is meant to explain.
 */
export interface GemPerformanceView {
  range: GemRange;
  points: GemPerformancePoint[];
  totals: Partial<Record<GemAssetRole, number | null>>;
  incomplete: boolean;
}

export interface GemHistoryEntryView {
  id: string;
  evaluatedOn: string;
  effectiveFrom: string;
  winner: GemAssetRef | null;
  state: GemSignalState;
  action: GemHistoryAction;
  momentum: GemMomentumSnapshot;
  change: { from: GemAssetRef | null; to: GemAssetRef | null } | null;
  executed: boolean | null;
}

/** One saved scenario, for the report's switcher. */
export interface GemStrategyRef {
  id: string;
  name: string;
}

export interface GemStrategyMetaView {
  /**
   * The saved scenario's id, or null when nothing is saved yet -- the report a
   * user gets before their first save describes a strategy that does not exist
   * in the database. It carried a `"gem"` sentinel before, which the client
   * then sent back as `?strategyId=gem` and every UUID-validated endpoint
   * rejected, so the very first save always failed.
   */
  id: string | null;
  /** Scenario name shown in the switcher and the report title. */
  name: string;
  cadence: GemCadence;
  /** Momentum lookback window in months. */
  lookbackMonths: number;
  /** Tax rate behind the transfer estimates, in percent; null when unset. */
  taxRatePercent: number | null;
  /**
   * Commission assumption **per trade**; null when unset. A switch out of two
   * holdings is three trades and is charged three times this amount.
   */
  commissionAmount: number | null;
  nextEvaluationOn: string | null;
  daysUntilNextEvaluation: number | null;
  pricesAsOf: string | null;
  rulesSourceUrl: string | null;
  rulesSourceLabel: string | null;
  /** Brokerage accounts the strategy is run in. */
  accounts: GemAccountRef[];
}

/**
 * Net-of-cost backtest summary: the stored evaluations replayed against real
 * prices (see `gem-backtest.util`). Null when there is nothing honest to
 * simulate -- fewer than two evaluated periods, or no prices for any of them --
 * and the client shows its empty state for that.
 */
export interface GemBacktestSummaryView {
  from: string;
  to: string;
  cagrPercent: number | null;
  maxDrawdownPercent: number | null;
  /**
   * Share of the simulated periods that beat the safe asset, 0-100. Null
   * unless every simulated period could be compared, so the figure never has a
   * denominator smaller than the run it is shown beside.
   */
  hitRatePercent: number | null;
  /**
   * Whether the configured tax rate was deducted, and whether the configured
   * commission was -- separately, because they fail independently: commission
   * needs a known portfolio total to become a drag and tax does not, so "net
   * of taxes and commissions" was being claimed for figures only tax had come
   * off. Both are false for a truncated run (`coveragePercent` below 100)
   * whatever the configuration says: a simulation that opens mid-strategy
   * knows neither the opening position nor its cost basis.
   */
  taxApplied: boolean;
  commissionApplied: boolean;
  /**
   * Share of the evaluated periods the simulation covers, 0-100. Below 100 the
   * earlier periods are excluded, not held flat: the run is the most recent
   * unbroken stretch of priced periods, and `from` is where it starts.
   */
  coveragePercent: number;
}

export interface GemStrategyReportView {
  strategy: GemStrategyMetaView;
  /** Every saved scenario, so the switcher can offer them. */
  strategies: GemStrategyRef[];
  assets: GemAssetRef[];
  signal: GemSignalView | null;
  position: GemPositionView | null;
  action: GemActionView | null;
  performance: GemPerformanceView | null;
  history: GemHistoryEntryView[];
  backtest: GemBacktestSummaryView | null;
  warnings: GemWarning[];
}
