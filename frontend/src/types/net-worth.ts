export interface MonthlyNetWorth {
  month: string; // "2023-01-01"
  assets: number;
  liabilities: number;
  netWorth: number;
}

export interface MonthlyInvestmentValue {
  month: string;
  /** Securities plus the cash beside them, at the month's close. */
  value: number;
  /**
   * The INVESTED part of the same month -- the securities, no cash. The
   * investment charts plot this; see `DailyInvestmentValue.securitiesValue`.
   */
  securitiesValue?: number;
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
  /**
   * `IV(t)`: the INVESTED part of that same close -- the securities, without
   * the cash beside them. `value` is this plus the scope's ledger cash.
   *
   * The investment charts plot THIS: cash held in an investment account is not
   * an investment, so a deposit must not draw as a rise in portfolio value
   * (INV-PORTRESULT-002, `docs/specs/portfolio-period-result.md` section 10.7).
   * The net worth chart is net worth and keeps reading `value`.
   *
   * Optional for the same reason the flags are: a response from an older
   * backend mid-deploy does not carry it.
   */
  securitiesValue?: number;
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
  /**
   * False when a security held at this point had no accepted close on or before
   * it: its band is absent entirely, so `total` is a subtotal of the rest.
   * Read as `=== false`.
   */
  pricesComplete?: boolean;
  /** The securities behind `pricesComplete: false`, so a reader can price them. */
  unpricedSecurityIds?: string[];
  /**
   * `"USD->EUR"` for each pair THIS point could not convert, so the dates that
   * need a rate are identifiable rather than only the pairs.
   */
  missingRatePairs?: string[];
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
  | 'zeroStart'
  /** A trade in the window settled outside the accounts whose cash is valued. */
  | 'externallySettledTrade'
  /** A split parent in the window mixes an investment line with ordinary cash. */
  | 'mixedSplit'
  /**
   * The money-weighted return alone: its schedule of dated flows defines no
   * single rate. The P&L and the time-weighted return are unaffected.
   */
  | 'mwrUndefined'
  /**
   * The money-weighted return alone: the window is too short to annualise, so
   * only its un-annualised total is reported.
   */
  | 'windowTooShort';

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

  // The INVESTED part of the same window: securities only, cash excluded
  // entirely. These are what "Portfolio performance" and the investment charts
  // report; the fields above are what the ACCOUNT did, which is the question
  // the daily movement notification and the calendar layer ask.

  /** IV(b): the securities at the starting close, no cash. */
  investedValueStart?: number | null;
  /** IV(e): the securities at the ending close, no cash. */
  investedValueEnd?: number | null;
  /** Net value paid into the securities after startDate: buys less disposals. */
  investmentCapitalFlows?: number | null;
  /** Dividends, interest and capital-gain distributions over the same days. */
  investmentIncome?: number | null;
  /** What the investments earned: IV(e) - IV(b) - capital + income. */
  investmentPnl?: number | null;
  /** The time-weighted return over the same days. */
  investmentReturnPercent?: number | null;
  /** How that percentage was arrived at; `twr` neutralises capital flows. */
  investmentReturnMethod?: 'twr';
  /**
   * The ANNUALISED money-weighted return (XIRR) over the same flows: what the
   * reader's own money earned, weighted by when it was paid in. Withheld with
   * `mwrUndefined` or `windowTooShort` among `investedReasons`.
   */
  investmentMoneyWeightedReturnPercent?: number | null;
  /** The same rate over the window rather than a year; a rate, not a realised total. */
  investmentMoneyWeightedTotalPercent?: number | null;
  /** How that rate was arrived at; `xirr` weights each flow by its own date. */
  investmentMoneyWeightedMethod?: 'xirr';
  /** True only when both invested figures are known. */
  investedComplete?: boolean;
  /** Why an invested figure is withheld; the same closed set as `reasons`. */
  investedReasons?: PeriodResultReason[];
}

/** The trailing windows the Investments page reports a portfolio result over. */
export const PORTFOLIO_PERIOD_PRESETS = [
  '1d',
  '1w',
  '1m',
  '3m',
  'ytd',
  '1y',
] as const;

export type PortfolioPeriodPreset = (typeof PORTFOLIO_PERIOD_PRESETS)[number];

/**
 * What GET /net-worth/investments-period-results answers: the same measure as
 * the single-range route, for several trailing windows at once.
 *
 * The server builds the value series once for the widest window and slices the
 * rest out of it, so six windows cost one valuation. A window the series does
 * not reach back to is absent from nothing -- it is present with every figure
 * null and `noValueSeries` among its reasons, which the card reads as "n/a".
 */
export interface PortfolioPeriodResults {
  /** The currency every figure in every period is in. */
  currency: string;
  /** The day every period is measured to. */
  asOf: string;
  periods: Partial<Record<PortfolioPeriodPreset, PortfolioPeriodResult>>;
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
