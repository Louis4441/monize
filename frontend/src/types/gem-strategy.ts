/**
 * View contract for the GEM (Global Equities Momentum) strategy report.
 *
 * These types describe the single read model the report page consumes -- they
 * mirror the strategy data the backend evaluates and hold no business logic of
 * their own. Every derived number (momentum, spreads, ranking, transfer value,
 * tax/commission estimates) is supplied by the server so the UI never
 * recomputes the strategy.
 *
 * `null` always means "not known" -- an unmapped role, missing price history,
 * no strategy account, or a value the server could not estimate. The UI renders
 * an explicit unknown marker for those, never a zero.
 */

/** The four roles a GEM strategy assigns an instrument to. */
/** How the report decided whether a holding counts towards the target. */
export type GemCompositionBasis = 'COMPOSITION' | 'INSTRUMENT';

/** The breakdown a composition comparison ran on. */
export type GemCompositionDimension = 'COUNTRY' | 'ASSET_CLASS' | 'SECTOR';

export type GemAssetRole =
  | 'US_EQUITY'
  | 'EX_US_EQUITY'
  | 'EM_EQUITY'
  | 'SAFE'
  | 'RISK_FREE';

/** Absolute-momentum outcome: equities in (RISK_ON) or safe asset (RISK_OFF). */
export type GemSignalState = 'RISK_ON' | 'RISK_OFF';

/** How often the strategy re-evaluates its signal. */
export type GemCadence = 'MONTHLY' | 'QUARTERLY';

/** What a historical evaluation asked the investor to do. */
export type GemHistoryAction = 'BUY' | 'HOLD' | 'SWITCH';

/** Selectable window for the asset-performance chart. */
export type GemRange = '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'MAX';

/** Conditions the server flags so the UI can explain incomplete output. */
export type GemWarningCode =
  | 'UNMAPPED_ROLE'
  | 'INCOMPLETE_HISTORY'
  | 'NO_ACCOUNT'
  | 'NO_POSITION'
  | 'FIRST_RUN'
  | 'STALE_PRICES'
  | 'CALCULATION_FAILED';

export interface GemWarning {
  code: GemWarningCode;
  /** Roles the warning applies to, when it is role-specific. */
  roles?: GemAssetRole[];
  /** Server-supplied detail (e.g. the stale price date), already localized. */
  detail?: string | null;
}

/** An instrument bound to a strategy role. `symbol`/`name` are null when the role has no ETF yet. */
export interface GemAssetRef {
  role: GemAssetRole;
  securityId: string | null;
  symbol: string | null;
  name: string | null;
}

export interface GemAssetMomentum extends GemAssetRef {
  /** Trailing 12-month total return, in percent. Null when history is incomplete. */
  momentum12m: number | null;
  /** 1-based rank among the equity assets; null for the safe asset or when unknown. */
  rank: number | null;
}

/** Step 1: equities (US) versus the risk-free asset. */
export interface GemAbsoluteStep {
  equity: GemAssetMomentum;
  /**
   * What equities were measured against: the dedicated risk-free leg when the
   * strategy assigns one, otherwise the safe asset.
   */
  benchmark: GemAssetMomentum;
  /** equity.momentum12m - benchmark.momentum12m in percentage points; null when either is unknown. */
  spreadPp: number | null;
  result: GemSignalState;
}

/** Step 2: the equity ranking, only decisive while RISK_ON. */
export interface GemRelativeStep {
  /** Equity assets ordered best-first. */
  ranking: GemAssetMomentum[];
  winner: GemAssetRef | null;
  /** Lead of rank 1 over rank 2, in percentage points; null when unknown. */
  leadPp: number | null;
  /** False when RISK_OFF makes the ranking irrelevant to the current allocation. */
  applied: boolean;
}

export interface GemSignal {
  id: string;
  state: GemSignalState;
  /** Instrument the strategy allocates to (equity winner, or the safe asset while RISK_OFF). */
  target: GemAssetRef | null;
  /** Target weight of the strategy portfolio in `target`, in percent (GEM uses 100). */
  targetWeightPercent: number;
  /** ISO date the signal became binding. */
  effectiveFrom: string;
  /** ISO date the signal was evaluated. */
  evaluatedOn: string;
  absolute: GemAbsoluteStep;
  relative: GemRelativeStep;
}

export interface GemAccountRef {
  id: string;
  name: string;
}

/**
 * An instrument actually held in the strategy accounts. `role` is null for a
 * holding that fills no strategy role -- the comparison covers the whole
 * portfolio, so those count towards the total and towards what a switch moves.
 */
export interface GemHeldAsset {
  role: GemAssetRole | null;
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
   * percentages of the holding. The compliance figure says a fifth of a fund
   * is on target; this says which fifth.
   */
  matchedMarkets: Array<{ name: string; percent: number }>;
}

/** Where the real portfolio stands versus the signal. */
export interface GemPosition {
  /** Brokerage accounts the position is summed across; empty when none is assigned. */
  accounts: GemAccountRef[];
  /** Everything held in those accounts, largest position first. */
  holdings: GemHeldAsset[];
  /** The largest holding -- what the accounts are effectively in; null when empty. */
  current: GemHeldAsset | null;
  target: GemAssetRef | null;
  /** Share of the accounts' whole market value already in the target, 0-100; null when unknown. */
  compliancePercent: number | null;
  changeRequired: boolean;
  /** Market value of everything held in the accounts; null when nothing can be priced. */
  totalMarketValue: number | null;
  /** Whether contents or tickers decided compliance. */
  basis: GemCompositionBasis;
  /** Breakdown the contents were compared on; null when tickers were used. */
  dimension: GemCompositionDimension | null;
  /** How many holdings fell back to a ticker comparison. */
  instrumentMatchedCount: number;
  currencyCode: string;
}

/** The single operation the strategy asks for, with the server's cost estimates. */
export interface GemAction {
  /** False when the portfolio already matches the signal. */
  required: boolean;
  /** Largest holding the switch sells out of; null when there is nothing to sell. */
  from: GemHeldAsset | null;
  /** How many instruments the switch sells out of, `from` included. */
  fromCount: number;
  to: GemAssetRef | null;
  /** Target weight of the destination instrument, in percent. */
  targetWeightPercent: number;
  /** Estimated value to move, in `currencyCode`; null when it cannot be estimated. */
  transferValue: number | null;
  /** Estimated realized gain (positive) or loss (negative) on the sale. */
  realizedGainLoss: number | null;
  /** Estimated tax on the realized gain; null when not applicable or unknown. */
  estimatedTax: number | null;
  /** Tax rate behind `estimatedTax`, in percent; null when unknown. */
  taxRatePercent: number | null;
  /** Estimated broker commission; null when unknown. */
  estimatedCommission: number | null;
  /** Trades the switch takes: one sell per off-target holding, plus the buy. */
  estimatedTradeCount: number;
  /** Brokerage accounts the operation spans; empty when none is assigned. */
  accounts: GemAccountRef[];
  currencyCode: string;
  /** True once the user marked this signal's operation as executed. */
  executed: boolean;
}

export interface GemPerformancePoint {
  /** ISO date of the observation. */
  date: string;
  /** Cumulative total return per role since the start of the range, in percent. */
  values: Partial<Record<GemAssetRole, number | null>>;
}

export interface GemPerformance {
  range: GemRange;
  points: GemPerformancePoint[];
  /** Cumulative total return per role at the end of the range, in percent. */
  totals: Partial<Record<GemAssetRole, number | null>>;
  /** Currency the returns are expressed in (the strategy account's base currency). */
  currencyCode: string;
  /** True when at least one asset lacks prices for the whole range. */
  incomplete: boolean;
}

export interface GemHistoryEntry {
  id: string;
  /** ISO date of the evaluation. */
  evaluatedOn: string;
  /** ISO date the resulting signal became binding. */
  effectiveFrom: string;
  winner: GemAssetRef | null;
  state: GemSignalState;
  action: GemHistoryAction;
  /** Trailing 12-month momentum per role at evaluation time, in percent. */
  momentum: Partial<Record<GemAssetRole, number | null>>;
  /** Instrument change the evaluation implied; null when the allocation was unchanged. */
  change: { from: GemAssetRef | null; to: GemAssetRef | null } | null;
  /** Whether the user carried the change out; null when there was nothing to do. */
  executed: boolean | null;
}

/** Net-of-cost backtest summary for the configured asset set. */
export interface GemBacktestSummary {
  /** ISO dates bounding the simulated period. */
  from: string;
  to: string;
  /** Compound annual growth rate, in percent. */
  cagrPercent: number | null;
  /** Worst peak-to-trough decline, in percent (negative). */
  maxDrawdownPercent: number | null;
  /** Share of evaluations whose signal beat the safe asset, in percent. */
  hitRatePercent: number | null;
  /** True when taxes and commissions are already deducted from the figures. */
  netOfCosts: boolean;
}

/** One saved scenario, for the report's switcher. */
export interface GemStrategyRef {
  id: string;
  name: string;
}

export interface GemStrategyMeta {
  id: string;
  /** Scenario name shown in the switcher and the report title. */
  name: string;
  cadence: GemCadence;
  /** Momentum lookback window in months. */
  lookbackMonths: number;
  /** Tax rate behind the transfer estimates, in percent; null when unset. */
  taxRatePercent: number | null;
  /** Commission assumption per switch; null when unset. */
  commissionAmount: number | null;
  /** ISO date of the next scheduled evaluation; null when unscheduled. */
  nextEvaluationOn: string | null;
  /** Whole days until `nextEvaluationOn`; null when unscheduled. */
  daysUntilNextEvaluation: number | null;
  /** ISO timestamp of the price data behind the report; null when no prices exist. */
  pricesAsOf: string | null;
  /** Where the strategy rules are documented (shown in the report footer). */
  rulesSourceUrl: string | null;
  rulesSourceLabel: string | null;
  /** Brokerage accounts the strategy trades in; their holdings are summed. */
  accounts: GemAccountRef[];
}

/** Everything the GEM report page renders, in one read. */
export interface GemStrategyReport {
  strategy: GemStrategyMeta;
  /** Every saved scenario, so the switcher can offer them. */
  strategies: GemStrategyRef[];
  /** All four roles, in strategy order. `symbol` is null for an unmapped role. */
  assets: GemAssetRef[];
  /** Null when the signal could not be evaluated (first run, failed calculation). */
  signal: GemSignal | null;
  position: GemPosition | null;
  action: GemAction | null;
  performance: GemPerformance | null;
  /** Newest evaluation first. */
  history: GemHistoryEntry[];
  backtest: GemBacktestSummary | null;
  warnings: GemWarning[];
}

/** One role assignment sent to the configuration endpoint. */
export interface GemAssetAssignmentInput {
  role: GemAssetRole;
  /** null clears the assignment, leaving the role unmapped. */
  securityId: string | null;
}

/**
 * Payload for PUT /strategies/gem. Every field is optional: omitting one leaves
 * the stored value alone, while sending `null` clears it.
 */
export interface GemStrategyConfigInput {
  /** Replaces the whole account set; an empty array unassigns every account. */
  accountIds?: string[];
  cadence?: GemCadence;
  lookbackMonths?: number;
  taxRatePercent?: number | null;
  commissionAmount?: number | null;
  rulesSourceUrl?: string | null;
  rulesSourceLabel?: string | null;
  assets?: GemAssetAssignmentInput[];
}
