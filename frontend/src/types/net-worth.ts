export interface MonthlyNetWorth {
  month: string; // "2023-01-01"
  assets: number;
  liabilities: number;
  netWorth: number;
}

export interface MonthlyInvestmentValue {
  month: string;
  value: number;
}

/**
 * One day of GET /net-worth/investments-daily.
 *
 * `value` is the scope's market value plus cash at that close -- and it is a
 * SUBTOTAL on any day either completeness flag is false: the server skips a
 * position it cannot price and drops a component it cannot convert. Read the
 * flags before printing this under a total's caption.
 *
 * All of the flags are optional because a response from an older backend
 * mid-deploy carries none of them, and absent means NO INFORMATION, not
 * "complete". That is why every read of them is `=== false`, never `!flag`:
 * truthiness turns a silent response into a withheld figure on every day.
 */
export interface DailyInvestmentValue {
  date: string;
  value: number;
  /** False when a component could not be converted; see missingRatePairs. */
  fxComplete?: boolean;
  /** `"USD->EUR"` for each pair with no rate on that day. */
  missingRatePairs?: string[];
  /**
   * False when a position held at that close had no accepted price on or before
   * it, so its market value is unknown rather than zero.
   */
  pricesComplete?: boolean;
  /** The securities behind `pricesComplete: false`, so a reader can price them. */
  unpricedSecurityIds?: string[];
  /**
   * False when a cash account in the scope produced no balance for this day, so
   * its contribution is unknown rather than zero.
   */
  cashComplete?: boolean;
  /** The accounts behind `cashComplete: false`. */
  unknownCashAccountIds?: string[];
}

export type InvestmentBreakdownGranularity = 'daily' | 'monthly';

/**
 * One stacked band on the Portfolio Value Over Time "by security" chart:
 * an individual security, the rolled-up "other" bucket, or aggregate cash.
 * `symbol`/`name` are only populated for real securities; `cash` and `other`
 * are labelled on the client so their copy stays localized.
 */
export interface InvestmentBreakdownSeries {
  key: string; // securityId, or the sentinel 'cash' / 'other'
  type: 'security' | 'cash' | 'other';
  symbol: string | null;
  name: string;
}

export interface InvestmentBreakdownPoint {
  date: string; // YYYY-MM-DD; month-first for monthly granularity
  total: number;
  values: Record<string, number>; // keyed by InvestmentBreakdownSeries.key
  /**
   * False when a cash account in the scope produced no balance for this point,
   * so the cash band and `total` are short a component whose value is unknown
   * rather than zero. Optional, and read as `=== false`: an older backend
   * mid-deploy sends neither flag, which is no information.
   */
  cashComplete?: boolean;
  /** The accounts behind `cashComplete: false`. */
  unknownCashAccountIds?: string[];
}

export interface InvestmentBreakdown {
  granularity: InvestmentBreakdownGranularity;
  currency: string;
  series: InvestmentBreakdownSeries[];
  points: InvestmentBreakdownPoint[];
  /** False when a component could not be converted into `currency`. */
  fxComplete?: boolean;
  /** `"USD->EUR"` for each pair with no rate; empty when complete. */
  missingRatePairs?: string[];
}

/**
 * Why a period's figures could not be reported, as the server's closed set.
 * `docs/specs/portfolio-period-result.md` section 4 is the truth table.
 */
export type PeriodResultReason =
  | 'noValueSeries'
  | 'incompletePrices'
  | 'incompleteCash'
  | 'missingRatePairs'
  | 'zeroStart';

/**
 * What GET /net-worth/investments-period-result answers: what the portfolio did
 * over the window, and how much of that was the reader's own money.
 *
 * Three figures, deliberately not one. `valueChange` is what the portfolio is
 * worth now less what it was worth then -- it counts a deposit. `netExternalFlows`
 * is that deposit. `investmentResult` is what is left, and it is the only one a
 * percentage belongs over: the report used to print the value change under a
 * "Return" caption, so two deposits with a flat price read as +100% (#1392).
 *
 * Every figure is nullable and carries its cause in `reasons`; nothing here is
 * re-derived on the client.
 */
export interface PortfolioPeriodResult {
  currency: string;
  /** The close the period is measured from (the baseline, where one applied). */
  startDate: string;
  endDate: string;
  startValue: number | null;
  endValue: number | null;
  valueChange: number | null;
  netExternalFlows: number | null;
  /** The part of the flow that converted, when the total is withheld. */
  knownFlowSubtotal: number;
  investmentResult: number | null;
  returnPercent: number | null;
  /** How the percentage was arrived at; `simple` is not time-weighted. */
  returnMethod: 'simple';
  complete: boolean;
  reasons: PeriodResultReason[];
  missingRatePairs: string[];
  unpricedSecurityIds: string[];
  unknownCashAccountIds: string[];
}

/**
 * Per-security intraday breakdown (1D / 1W / 1M ranges). Same band shape as
 * the daily/monthly breakdown, but points are keyed by timestamp and the
 * response carries the intraday availability metadata so the report applies the
 * same fallback handling as the total intraday series.
 */
export interface IntradayBreakdownPoint {
  timestamp: string;
  total: number;
  values: Record<string, number>;
}

export interface IntradayBreakdown {
  series: InvestmentBreakdownSeries[];
  points: IntradayBreakdownPoint[];
  interval: '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m';
  currency: string;
  range: '1d' | '1w' | '1m';
  fetchedAt: string;
  skippedSymbols: string[];
  failedSymbols: string[];
  fallbackToDaily: boolean;
}
