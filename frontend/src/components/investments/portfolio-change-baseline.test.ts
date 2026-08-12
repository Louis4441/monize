import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BASELINE_LOOKBACK_DAYS,
  buildPriorCloseKey,
  fetchPriorCloseBaseline,
  isoDatePart,
  previousCalendarDay,
  priorCloseChange,
  selectPriorClose,
  shiftIsoDate,
  usesPriorCloseBaseline,
} from './portfolio-change-baseline';
import { netWorthApi } from '@/lib/net-worth';

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsDaily: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

describe('usesPriorCloseBaseline', () => {
  it('covers the intraday-boundary ranges only', () => {
    expect(usesPriorCloseBaseline('1d')).toBe(true);
    expect(usesPriorCloseBaseline('1w')).toBe(true);
    expect(usesPriorCloseBaseline('mtd')).toBe(true);
    for (const range of ['1m', '3m', 'ytd', '1y', '2y', '5y', 'all', 'custom']) {
      expect(usesPriorCloseBaseline(range)).toBe(false);
    }
  });

  /**
   * This was briefly a user preference (`portfolio_change_baseline`, added by
   * migration 152 and dropped by 153). It is now a property of the range and
   * nothing else: the prior close is the answer every quote source gives for a
   * daily move, so there was no second answer worth asking the user to pick.
   */
  it('depends on the range alone', () => {
    expect(usesPriorCloseBaseline.length).toBe(1);
  });
});

describe('shiftIsoDate / previousCalendarDay', () => {
  it('steps across a month boundary', () => {
    expect(previousCalendarDay('2026-08-01')).toBe('2026-07-31');
    expect(shiftIsoDate('2026-08-01', -30)).toBe('2026-07-02');
  });

  it('steps across a year boundary', () => {
    expect(previousCalendarDay('2026-01-01')).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(previousCalendarDay('2024-03-01')).toBe('2024-02-29');
  });

  it('does not drift a day under a negative UTC offset', () => {
    // The arithmetic is UTC-based, so it cannot land on the previous day the
    // way `new Date('2026-08-01')` + local getDate() would west of Greenwich.
    expect(previousCalendarDay('2026-08-12')).toBe('2026-08-11');
  });
});

describe('isoDatePart', () => {
  it('takes the date half of an intraday timestamp', () => {
    expect(isoDatePart('2026-08-12T13:30:00.000Z')).toBe('2026-08-12');
  });

  it('passes a plain date through', () => {
    expect(isoDatePart('2026-08-12')).toBe('2026-08-12');
  });

  it('rejects a month key and an empty point', () => {
    // Monthly points are 'YYYY-MM'; there is no day to measure a close from.
    expect(isoDatePart('2026-08')).toBeNull();
    expect(isoDatePart(undefined)).toBeNull();
    expect(isoDatePart('')).toBeNull();
  });
});

describe('selectPriorClose', () => {
  const rows = [
    { date: '2026-08-03', value: 900 },
    { date: '2026-08-04', value: 1000 },
    { date: '2026-08-05', value: 1100 },
    { date: '2026-08-06', value: 1200 },
  ];

  it('picks the last day strictly before the first plotted point', () => {
    // The user's example: a 1W chart drawn from Aug 5 measures from Aug 4.
    expect(selectPriorClose(rows, '2026-08-05')).toEqual({
      date: '2026-08-04',
      value: 1000,
    });
  });

  it('never picks the first plotted day itself', () => {
    expect(selectPriorClose(rows, '2026-08-03')).toBeNull();
  });

  it('is unknown when the series does not reach back far enough', () => {
    expect(selectPriorClose([], '2026-08-05')).toBeNull();
    expect(selectPriorClose(rows, '2026-07-01')).toBeNull();
  });

  it('does not depend on the rows being ordered', () => {
    expect(selectPriorClose([...rows].reverse(), '2026-08-05')).toEqual({
      date: '2026-08-04',
      value: 1000,
    });
  });

  it('keeps a genuine zero rather than reading it as unknown', () => {
    // Nothing held the day before is a known zero, not a missing baseline.
    expect(
      selectPriorClose([{ date: '2026-08-04', value: 0 }], '2026-08-05'),
    ).toEqual({ date: '2026-08-04', value: 0 });
  });
});

describe('fetchPriorCloseBaseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests a window ending the day before the first point', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2026-08-04', value: 1000 },
    ]);
    const result = await fetchPriorCloseBaseline({
      key: 'k',
      firstPointDate: '2026-08-05',
      accountIds: 'a,b',
      displayCurrency: 'USD',
    });
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith({
      startDate: shiftIsoDate('2026-08-04', -BASELINE_LOOKBACK_DAYS),
      endDate: '2026-08-04',
      accountIds: 'a,b',
      displayCurrency: 'USD',
    });
    expect(result).toEqual({ key: 'k', date: '2026-08-04', value: 1000 });
  });

  it('is unknown -- not zero -- when the lookup fails', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockRejectedValue(
      new Error('boom'),
    );
    await expect(
      fetchPriorCloseBaseline({ key: 'k', firstPointDate: '2026-08-05' }),
    ).resolves.toBeNull();
  });

  it('is unknown when the series has nothing before the first point', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([]);
    await expect(
      fetchPriorCloseBaseline({ key: 'k', firstPointDate: '2026-08-05' }),
    ).resolves.toBeNull();
  });
});

describe('buildPriorCloseKey', () => {
  it('separates two requests that differ only by account filter', () => {
    const base = { range: '1w', firstPointDate: '2026-08-05' };
    expect(buildPriorCloseKey({ ...base, accountIds: 'a' })).not.toBe(
      buildPriorCloseKey({ ...base, accountIds: 'b' }),
    );
  });

  it('separates two requests that differ only by display currency', () => {
    const base = { range: '1w', firstPointDate: '2026-08-05' };
    expect(buildPriorCloseKey({ ...base, displayCurrency: 'USD' })).not.toBe(
      buildPriorCloseKey({ ...base, displayCurrency: 'CAD' }),
    );
  });

  it('separates two ranges that happen to start on the same day', () => {
    expect(
      buildPriorCloseKey({ range: '1w', firstPointDate: '2026-08-05' }),
    ).not.toBe(buildPriorCloseKey({ range: 'mtd', firstPointDate: '2026-08-05' }));
  });
});

describe('priorCloseChange', () => {
  it('measures from the baseline, not from the first point', () => {
    expect(priorCloseChange(1100, 1000)).toEqual({
      change: 100,
      changePercent: 10,
    });
  });

  it('reports a fall as a negative change', () => {
    const { change, changePercent } = priorCloseChange(900, 1000);
    expect(change).toBe(-100);
    expect(changePercent).toBeCloseTo(-10, 10);
  });

  it('is unknown when the baseline is unknown', () => {
    expect(priorCloseChange(1100, null)).toEqual({
      change: null,
      changePercent: null,
    });
  });

  it('has no percentage against a zero baseline', () => {
    // A move away from nothing has no percentage; 0% would claim it did not
    // move, and Infinity is not a number anybody wants on a card.
    expect(priorCloseChange(1100, 0)).toEqual({
      change: 1100,
      changePercent: null,
    });
  });

  it('leaves no float dust behind on a large subtraction', () => {
    expect(priorCloseChange(1234567.89, 1234567.88).change).toBe(0.01);
  });

  it('percentages a negative baseline off its magnitude', () => {
    // A margin account can sit below zero; the sign of the change is the
    // direction the value moved, not the sign of the base.
    expect(priorCloseChange(-900, -1000)).toEqual({
      change: 100,
      changePercent: 10,
    });
  });
});
