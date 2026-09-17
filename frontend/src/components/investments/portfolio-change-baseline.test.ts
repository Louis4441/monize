import { describe, it, expect } from 'vitest';
import {
  isoDatePart,
  previousCalendarDay,
  shiftIsoDate,
  usesPriorCloseBaseline,
} from './portfolio-change-baseline';

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
