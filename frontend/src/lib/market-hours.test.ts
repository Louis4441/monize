import { describe, it, expect } from 'vitest';
import { getMarketState } from './market-hours';

const NYSE = {
  timezone: 'America/New_York',
  openTime: '09:30:00',
  closeTime: '16:00:00',
};

/** 2026-07-30 is a Thursday; the times below are UTC. */
const thursday = (utc: string) => new Date(`2026-07-30T${utc}Z`);

describe('getMarketState', () => {
  it('is open during the session, in the market timezone not the browser', () => {
    // 14:00 UTC is 10:00 in New York, half an hour after the open.
    expect(getMarketState(NYSE, thursday('14:00:00'))).toBe('open');
  });

  it('is closed before the open', () => {
    // 13:00 UTC is 09:00 New York.
    expect(getMarketState(NYSE, thursday('13:00:00'))).toBe('closed');
  });

  it('is closed at the closing bell, not still open through it', () => {
    // 20:00 UTC is exactly 16:00 New York.
    expect(getMarketState(NYSE, thursday('20:00:00'))).toBe('closed');
  });

  it('is open at the opening bell', () => {
    expect(getMarketState(NYSE, thursday('13:30:00'))).toBe('open');
  });

  it('is closed at the weekend even inside session hours', () => {
    // Saturday 2026-08-01, 14:00 UTC = 10:00 New York.
    expect(getMarketState(NYSE, new Date('2026-08-01T14:00:00Z'))).toBe('closed');
    // Sunday.
    expect(getMarketState(NYSE, new Date('2026-08-02T14:00:00Z'))).toBe('closed');
  });

  it('follows daylight saving through the zone, not a stored offset', () => {
    // January: New York is on EST (UTC-5), so 14:30 UTC is 09:30 -- the open.
    expect(getMarketState(NYSE, new Date('2026-01-15T14:30:00Z'))).toBe('open');
    // The same UTC instant in July is 10:30 EDT, also open, but 13:30 UTC is
    // 09:30 in July and 08:30 in January -- open then, closed now.
    expect(getMarketState(NYSE, new Date('2026-01-15T13:30:00Z'))).toBe('closed');
  });

  it('handles a market whose session runs in another part of the world', () => {
    const lse = { timezone: 'Europe/London', openTime: '08:00:00', closeTime: '16:30:00' };
    // 09:00 UTC in July is 10:00 London.
    expect(getMarketState(lse, thursday('09:00:00'))).toBe('open');
    // 17:00 UTC is 18:00 London.
    expect(getMarketState(lse, thursday('17:00:00'))).toBe('closed');
  });

  it('says unknown rather than guessing when there is no session on record', () => {
    expect(getMarketState(null)).toBe('unknown');
    expect(getMarketState(undefined)).toBe('unknown');
    expect(getMarketState({ timezone: 'America/New_York' })).toBe('unknown');
    expect(getMarketState({ openTime: '09:30:00', closeTime: '16:00:00' })).toBe(
      'unknown',
    );
  });

  it('says unknown for a timezone it cannot resolve', () => {
    // Better than defaulting to a zone and reporting a confident wrong answer.
    expect(
      getMarketState({ ...NYSE, timezone: 'Mars/Olympus_Mons' }, thursday('14:00:00')),
    ).toBe('unknown');
  });
});
