import { describe, expect, it } from 'vitest';
import {
  PORTFOLIO_WINDOW_STARTS,
  applyPortfolioWindowStart,
  needsFirstPricedDay,
  resolvePortfolioRangeWindow,
  startOfYearIso,
} from './portfolio-range-window';
import { resolveRangePreset } from '@/lib/date-range';

// Wednesday 12 August 2026, the day the rules were specified against.
const NOW = new Date(2026, 7, 12);

const startFor = (range: string, extra = {}) =>
  resolvePortfolioRangeWindow(range, { now: NOW, ...extra }).start;

describe('resolvePortfolioRangeWindow', () => {
  /**
   * The anniversary rule, stated the way it was asked for: today is
   * 12 Aug 2026, so a 1Y chart opens on the close of 11 Aug 2025.
   */
  it('opens 1Y on the day before the anniversary', () => {
    expect(startFor('1y')).toBe('2025-08-11');
  });

  it('opens 2Y and 5Y on the same rule', () => {
    expect(startFor('2y')).toBe('2024-08-11');
    expect(startFor('5y')).toBe('2021-08-11');
  });

  /**
   * 2Y used to be a flat 730-day count. That lands on the anniversary itself
   * only when no leap day falls in the window, and a day off it when one does
   * -- either way it is not the day *before* the anniversary, which is what a
   * price series has to open on.
   */
  it('2Y follows the calendar, not a 730-day count', () => {
    expect(startFor('2y')).not.toBe(
      resolveRangePreset('2y', { now: NOW }).start,
    );
  });

  it('opens 3M and 6M on the day before the period', () => {
    expect(startFor('3m')).toBe('2026-05-11');
    expect(startFor('6m')).toBe('2026-02-11');
  });

  /**
   * A rule naming an exact day has no month-aligned reading, so alignment is
   * ignored where one applies. Under the old resolver the report's 5Y opened
   * on the first of a month.
   */
  it('ignores month alignment where an exact day is named', () => {
    expect(startFor('5y', { alignment: 'month' })).toBe('2021-08-11');
    expect(startFor('1y', { alignment: 'month' })).toBe('2025-08-11');
  });

  it('leaves the intraday ranges alone', () => {
    for (const range of ['1d', '1w', 'mtd', '1m']) {
      expect(startFor(range)).toBe(
        resolveRangePreset(range, { now: NOW }).start,
      );
    }
  });

  it('passes an unknown range straight through', () => {
    expect(startFor('7y')).toBe(resolveRangePreset('7y', { now: NOW }).start);
  });

  it('keeps a custom range custom', () => {
    expect(
      resolvePortfolioRangeWindow('custom', {
        now: NOW,
        startDate: '2024-03-04',
        endDate: '2024-05-06',
      }),
    ).toEqual({ start: '2024-03-04', end: '2024-05-06' });
  });

  it('always ends today', () => {
    for (const range of ['1y', '3m', 'ytd', '5y']) {
      expect(resolvePortfolioRangeWindow(range, { now: NOW }).end).toBe(
        '2026-08-12',
      );
    }
  });

  describe('YTD', () => {
    it('opens on the year’s first priced day when one is known', () => {
      expect(startFor('ytd', { ytdFirstPricedDay: '2026-01-02' })).toBe(
        '2026-01-02',
      );
    });

    /**
     * Unknown is not "1 January is a trading day": the lookup has not answered,
     * or the scope holds nothing priced. Keeping the calendar boundary draws
     * every real close it has, one day wider than asked for -- the failure that
     * matters would be claiming a trading day nobody observed.
     */
    it('falls back to the calendar boundary when it is unknown', () => {
      expect(startFor('ytd')).toBe('2026-01-01');
      expect(startFor('ytd', { ytdFirstPricedDay: null })).toBe('2026-01-01');
    });
  });
});

describe('applyPortfolioWindowStart', () => {
  /**
   * The report and the Investments chart hand in the window `useDateRange`
   * already resolved, which is what carries a user's custom dates. The rule
   * must layer onto that rather than re-deriving it.
   */
  it('overrides the start of a window it is handed, keeping the end', () => {
    expect(
      applyPortfolioWindowStart(
        '1y',
        { start: '2025-08-12', end: '2026-08-12' },
        { now: NOW },
      ),
    ).toEqual({ start: '2025-08-11', end: '2026-08-12' });
  });

  it('returns an inherited range untouched', () => {
    const base = { start: '2026-07-13', end: '2026-08-12' };
    expect(applyPortfolioWindowStart('1m', base, { now: NOW })).toEqual(base);
  });
});

describe('needsFirstPricedDay', () => {
  it('is true for YTD alone, so only YTD pays for the extra request', () => {
    const asking = Object.keys(PORTFOLIO_WINDOW_STARTS).filter(
      needsFirstPricedDay,
    );
    expect(asking).toEqual(['ytd']);
  });
});

describe('startOfYearIso', () => {
  it('is 1 January of the year “now” falls in', () => {
    expect(startOfYearIso(NOW)).toBe('2026-01-01');
    expect(startOfYearIso(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(startOfYearIso(new Date(2026, 11, 31))).toBe('2026-01-01');
  });
});
