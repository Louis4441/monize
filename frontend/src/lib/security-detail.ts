import { format, subDays, subYears } from 'date-fns';
import { roundToDecimals } from './format';
import type {
  SecurityPrice,
  SecurityHistoryTransaction,
} from '@/types/investment';

/** What the detail page's main chart plots. */
export type SecurityChartMode = 'price' | 'value' | 'return';

/** The trailing periods the Performance card reports. */
export const PERFORMANCE_PERIODS = [
  '1m',
  '3m',
  'ytd',
  '1y',
  '3y',
  '5y',
] as const;

export type PerformancePeriod = (typeof PERFORMANCE_PERIODS)[number];

/** Presets offered above the chart, in the keys `resolveRangePreset` knows. */
export const CHART_RANGES = ['1m', '3m', 'ytd', '1y', '5y', 'all'] as const;

/** One close price, oldest-first once through `toPriceSeries`. */
export interface SecurityPricePoint {
  /** ISO `yyyy-MM-dd`. */
  date: string;
  close: number;
}

/** The share count from `date` onwards, until the next step. */
export interface QuantityStep {
  date: string;
  quantity: number;
}

/** A point in the shape `BalanceHistoryChart` consumes. */
export interface SeriesPoint {
  date: string;
  balance: number;
}

/**
 * Close prices as an oldest-first series. The prices API returns newest-first,
 * and every calculation here walks forward in time.
 */
export function toPriceSeries(
  prices: readonly SecurityPrice[],
): SecurityPricePoint[] {
  return prices
    .map((price) => ({
      date: price.priceDate.slice(0, 10),
      close: Number(price.closePrice),
    }))
    .filter((point) => isFinite(point.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The position's size over time, as a step per date it changed.
 *
 * Read straight off `runningQuantityAll`, which the backend already computes by
 * replaying the history -- so the steps here agree with the running totals the
 * transaction table shows rather than being a second, parallel tally. Several
 * trades on one day collapse to that day's final balance.
 */
export function buildQuantitySteps(
  transactions: readonly SecurityHistoryTransaction[],
): QuantityStep[] {
  const byDate = new Map<string, number>();
  for (const transaction of transactions) {
    const date = transaction.transactionDate.slice(0, 10);
    // The history is ordered, so the last write for a day is that day's close.
    byDate.set(date, Number(transaction.runningQuantityAll) || 0);
  }
  return [...byDate.entries()]
    .map(([date, quantity]) => ({ date, quantity }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Shares held on `date`: the most recent step at or before it, or zero for a
 * date before the first trade.
 */
export function quantityAt(
  steps: readonly QuantityStep[],
  date: string,
): number {
  let quantity = 0;
  for (const step of steps) {
    if (step.date > date) break;
    quantity = step.quantity;
  }
  return quantity;
}

/**
 * Turn a price window into the series the chart draws.
 *
 * `price` is the quoted close. `value` multiplies it by the shares held that
 * day, so the line answers "what was my position worth" rather than "what did
 * one unit cost". `return` re-bases the window on its own first point, which is
 * why it must be given the already-filtered window: a 1Y return is measured
 * from the start of that year of data, not from the start of all history.
 */
export function buildChartSeries(
  window: readonly SecurityPricePoint[],
  steps: readonly QuantityStep[],
  mode: SecurityChartMode,
): SeriesPoint[] {
  if (mode === 'price') {
    return window.map((point) => ({ date: point.date, balance: point.close }));
  }

  if (mode === 'value') {
    return window.map((point) => ({
      date: point.date,
      balance: roundToDecimals(point.close * quantityAt(steps, point.date), 4),
    }));
  }

  const baseline = window[0]?.close;
  // Without a usable baseline there is no percentage to state, so the caller
  // gets an empty series and renders the chart's own no-data state.
  if (baseline === undefined || baseline === 0) return [];
  return window.map((point) => ({
    date: point.date,
    balance: roundToDecimals((point.close / baseline - 1) * 100, 4),
  }));
}

/**
 * First day of a trailing period, in the same conventions
 * `resolveRangePreset` uses (a month is 30 days, a quarter 90, YTD is Jan 1),
 * plus the 3-year period the Performance card needs and that preset lacks.
 */
export function periodStartDate(
  period: PerformancePeriod,
  now: Date = new Date(),
): string {
  switch (period) {
    case '1m':
      return format(subDays(now, 30), 'yyyy-MM-dd');
    case '3m':
      return format(subDays(now, 90), 'yyyy-MM-dd');
    case 'ytd':
      return `${now.getFullYear()}-01-01`;
    case '1y':
      return format(subYears(now, 1), 'yyyy-MM-dd');
    case '3y':
      return format(subYears(now, 3), 'yyyy-MM-dd');
    case '5y':
      return format(subYears(now, 5), 'yyyy-MM-dd');
  }
}

/**
 * Percent change from the last price at or before `startDate` to the newest
 * price in the series.
 *
 * Returns null when the history does not reach back that far. That is the whole
 * point of the null: a security listed two years ago has no five-year return,
 * and measuring from its first day instead would report a number that looks
 * like one.
 */
export function computePeriodReturn(
  series: readonly SecurityPricePoint[],
  startDate: string,
): number | null {
  if (series.length === 0) return null;

  let baseline: SecurityPricePoint | undefined;
  for (const point of series) {
    if (point.date > startDate) break;
    baseline = point;
  }
  if (!baseline || baseline.close === 0) return null;

  const latest = series[series.length - 1];
  // A baseline that is also the newest point spans no time at all.
  if (latest.date === baseline.date) return null;

  return roundToDecimals((latest.close / baseline.close - 1) * 100, 2);
}

/** Prices within `[start, end]`; an empty `start` means "from the beginning". */
export function filterPriceWindow(
  series: readonly SecurityPricePoint[],
  start: string,
  end: string,
): SecurityPricePoint[] {
  return series.filter(
    (point) => (!start || point.date >= start) && (!end || point.date <= end),
  );
}
