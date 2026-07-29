import { describe, it, expect } from 'vitest';
import {
  totalReturnOf,
  toPriceSeries,
  buildQuantitySteps,
  quantityAt,
  buildChartSeries,
  periodStartDate,
  computePeriodReturn,
  filterPriceWindow,
} from './security-detail';
import type {
  SecurityPrice,
  SecurityHistoryTransaction,
} from '@/types/investment';

function price(
  priceDate: string,
  closePrice: number,
  adjustedClose: number | null = null,
): SecurityPrice {
  return {
    id: 1,
    securityId: 'sec-1',
    priceDate,
    openPrice: null,
    highPrice: null,
    lowPrice: null,
    closePrice,
    adjustedClose,
    volume: null,
    source: 'yahoo_finance',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function transaction(
  transactionDate: string,
  runningQuantityAll: number,
): SecurityHistoryTransaction {
  return {
    id: `tx-${transactionDate}-${runningQuantityAll}`,
    transactionDate,
    accountId: 'acct-1',
    accountName: 'Brokerage',
    action: 'BUY',
    quantity: runningQuantityAll,
    price: 100,
    commission: 0,
    totalAmount: 100,
    description: null,
    runningQuantityAccount: runningQuantityAll,
    runningQuantityAll,
  };
}

describe('totalReturnOf', () => {
  it('prefers the adjusted close', () => {
    expect(totalReturnOf({ date: '2026-01-01', close: 100, totalReturnClose: 104 })).toBe(104);
  });

  it('falls back to the quoted close when there is no adjusted one', () => {
    // Same rule as the backend's COALESCE(adjusted_close, close_price).
    expect(totalReturnOf({ date: '2026-01-01', close: 100 })).toBe(100);
  });
});

describe('toPriceSeries', () => {
  it('carries the adjusted close through when the provider supplies one', () => {
    const [point] = toPriceSeries([price('2026-01-01', 100, 97.5)]);
    expect(point.close).toBe(100);
    expect(point.totalReturnClose).toBe(97.5);
  });

  it('leaves the total-return value unset for a provider without one', () => {
    // MSN stores null here; the series must not pretend price is total return.
    const [point] = toPriceSeries([price('2026-01-01', 100, null)]);
    expect(point.totalReturnClose).toBeUndefined();
  });

  it('ignores a nonsensical adjusted close', () => {
    const [point] = toPriceSeries([price('2026-01-01', 100, 0)]);
    expect(point.totalReturnClose).toBeUndefined();
  });

  it('flips the newest-first API order into oldest-first', () => {
    const series = toPriceSeries([
      price('2026-03-01', 30),
      price('2026-01-01', 10),
      price('2026-02-01', 20),
    ]);
    expect(series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  it('trims a timestamp down to the calendar day', () => {
    const series = toPriceSeries([price('2026-01-15T00:00:00.000Z', 10)]);
    expect(series[0].date).toBe('2026-01-15');
  });

  it('drops rows whose price is not a number', () => {
    const series = toPriceSeries([
      price('2026-01-01', 10),
      { ...price('2026-01-02', 0), closePrice: NaN },
    ]);
    expect(series).toHaveLength(1);
  });
});

describe('buildQuantitySteps', () => {
  it('reads the running total the backend already computed', () => {
    const steps = buildQuantitySteps([
      transaction('2024-01-01', 10),
      transaction('2024-06-01', 25),
      transaction('2025-01-01', 5),
    ]);
    expect(steps).toEqual([
      { date: '2024-01-01', quantity: 10 },
      { date: '2024-06-01', quantity: 25 },
      { date: '2025-01-01', quantity: 5 },
    ]);
  });

  it('collapses several trades on one day to that day s closing balance', () => {
    const steps = buildQuantitySteps([
      transaction('2024-01-01', 10),
      transaction('2024-01-01', 30),
      transaction('2024-01-01', 22),
    ]);
    expect(steps).toEqual([{ date: '2024-01-01', quantity: 22 }]);
  });

  it('returns nothing for a security that was never traded', () => {
    expect(buildQuantitySteps([])).toEqual([]);
  });
});

describe('quantityAt', () => {
  const steps = [
    { date: '2024-01-01', quantity: 10 },
    { date: '2024-06-01', quantity: 25 },
  ];

  it('holds the last step forward in time', () => {
    expect(quantityAt(steps, '2024-03-15')).toBe(10);
    expect(quantityAt(steps, '2025-12-31')).toBe(25);
  });

  it('includes the step s own day', () => {
    expect(quantityAt(steps, '2024-06-01')).toBe(25);
  });

  it('is zero before the first trade', () => {
    expect(quantityAt(steps, '2023-12-31')).toBe(0);
  });
});

describe('buildChartSeries', () => {
  const window = [
    { date: '2024-01-01', close: 100 },
    { date: '2024-02-01', close: 110 },
    { date: '2024-03-01', close: 90 },
  ];
  const steps = [
    { date: '2024-01-01', quantity: 10 },
    { date: '2024-02-15', quantity: 20 },
  ];

  it('plots the quoted close in price mode', () => {
    expect(buildChartSeries(window, steps, 'price')).toEqual([
      { date: '2024-01-01', balance: 100 },
      { date: '2024-02-01', balance: 110 },
      { date: '2024-03-01', balance: 90 },
    ]);
  });

  it('multiplies price by the shares held that day in value mode', () => {
    expect(buildChartSeries(window, steps, 'value')).toEqual([
      { date: '2024-01-01', balance: 1000 },
      { date: '2024-02-01', balance: 1100 },
      // The 15 Feb top-up doubles the position before the March point.
      { date: '2024-03-01', balance: 1800 },
    ]);
  });

  it('uses the adjusted series in return mode, matching the Performance card', () => {
    const withAdjusted = [
      { date: '2024-01-01', close: 100, totalReturnClose: 100 },
      { date: '2024-02-01', close: 100, totalReturnClose: 102 },
    ];
    expect(buildChartSeries(withAdjusted, [], 'return')).toEqual([
      { date: '2024-01-01', balance: 0 },
      { date: '2024-02-01', balance: 2 },
    ]);
  });

  it('keeps price and value modes on the quoted close', () => {
    // The adjusted series is not what the security traded at, so neither the
    // price line nor the position's value may use it.
    const withAdjusted = [{ date: '2024-01-01', close: 100, totalReturnClose: 90 }];
    expect(buildChartSeries(withAdjusted, [], 'price')).toEqual([
      { date: '2024-01-01', balance: 100 },
    ]);
    expect(
      buildChartSeries(withAdjusted, [{ date: '2024-01-01', quantity: 2 }], 'value'),
    ).toEqual([{ date: '2024-01-01', balance: 200 }]);
  });

  it('re-bases the window on its own first point in return mode', () => {
    expect(buildChartSeries(window, steps, 'return')).toEqual([
      { date: '2024-01-01', balance: 0 },
      { date: '2024-02-01', balance: 10 },
      { date: '2024-03-01', balance: -10 },
    ]);
  });

  it('gives up on return mode when the baseline is unusable', () => {
    expect(buildChartSeries([], steps, 'return')).toEqual([]);
    expect(
      buildChartSeries([{ date: '2024-01-01', close: 0 }], steps, 'return'),
    ).toEqual([]);
  });

  it('values an untraded window at zero rather than at the price', () => {
    const series = buildChartSeries(window, [], 'value');
    expect(series.every((point) => point.balance === 0)).toBe(true);
  });
});

describe('periodStartDate', () => {
  const now = new Date('2026-07-28T12:00:00Z');

  it('matches the app s existing preset conventions', () => {
    expect(periodStartDate('1m', now)).toBe('2026-06-28');
    expect(periodStartDate('3m', now)).toBe('2026-04-29');
    expect(periodStartDate('1y', now)).toBe('2025-07-28');
    expect(periodStartDate('5y', now)).toBe('2021-07-28');
  });

  it('starts the year-to-date period on 1 January', () => {
    expect(periodStartDate('ytd', now)).toBe('2026-01-01');
  });

  it('supports the three-year period the shared preset helper lacks', () => {
    expect(periodStartDate('3y', now)).toBe('2023-07-28');
  });
});

describe('computePeriodReturn', () => {
  it('measures the return on the adjusted series, dividends included', () => {
    // Price is flat, but the adjusted series rose 4%: a distributing fund whose
    // return is entirely its dividend. Measured on price it would read 0%.
    const series = [
      { date: '2024-01-01', close: 100, totalReturnClose: 100 },
      { date: '2026-01-01', close: 100, totalReturnClose: 104 },
    ];
    expect(computePeriodReturn(series, '2024-06-01')).toBe(4);
  });

  it('falls back to price when the provider gives no adjusted series', () => {
    const series = [
      { date: '2024-01-01', close: 100 },
      { date: '2026-01-01', close: 110 },
    ];
    expect(computePeriodReturn(series, '2024-06-01')).toBe(10);
  });

  const series = [
    { date: '2024-01-01', close: 100 },
    { date: '2025-01-01', close: 120 },
    { date: '2026-01-01', close: 150 },
  ];

  it('measures from the last price at or before the start date', () => {
    // From 120 (1 Jan 2025) to the latest 150.
    expect(computePeriodReturn(series, '2025-06-01')).toBe(25);
  });

  it('uses a price that falls exactly on the start date', () => {
    expect(computePeriodReturn(series, '2025-01-01')).toBe(25);
  });

  it('reports a loss with a negative sign', () => {
    const falling = [
      { date: '2024-01-01', close: 200 },
      { date: '2026-01-01', close: 150 },
    ];
    expect(computePeriodReturn(falling, '2024-06-01')).toBe(-25);
  });

  it('returns null when the history does not reach the period start', () => {
    // A security listed in 2024 has no 2019-based return to report.
    expect(computePeriodReturn(series, '2019-01-01')).toBeNull();
  });

  it('returns null for an empty history', () => {
    expect(computePeriodReturn([], '2024-01-01')).toBeNull();
  });

  it('returns null when the baseline is also the newest price', () => {
    const single = [{ date: '2026-01-01', close: 150 }];
    expect(computePeriodReturn(single, '2026-06-01')).toBeNull();
  });

  it('returns null rather than dividing by a zero baseline', () => {
    const zeroed = [
      { date: '2024-01-01', close: 0 },
      { date: '2026-01-01', close: 150 },
    ];
    expect(computePeriodReturn(zeroed, '2024-06-01')).toBeNull();
  });

  it('rounds to two decimals', () => {
    const thirds = [
      { date: '2024-01-01', close: 3 },
      { date: '2026-01-01', close: 4 },
    ];
    expect(computePeriodReturn(thirds, '2024-06-01')).toBe(33.33);
  });
});

describe('filterPriceWindow', () => {
  const series = [
    { date: '2024-01-01', close: 10 },
    { date: '2025-01-01', close: 20 },
    { date: '2026-01-01', close: 30 },
  ];

  it('keeps both boundary days', () => {
    expect(
      filterPriceWindow(series, '2024-01-01', '2025-01-01').map((p) => p.date),
    ).toEqual(['2024-01-01', '2025-01-01']);
  });

  it('treats an empty start as all of history', () => {
    expect(filterPriceWindow(series, '', '2026-01-01')).toHaveLength(3);
  });
});
