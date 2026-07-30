import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRelativeTime } from './useRelativeTime';

const language = { current: 'en' as string | undefined };

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: { language: language.current } }),
}));

/** `n` minutes before now, as an ISO string. */
const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60 * 1000).toISOString();

function format() {
  return renderHook(() => useRelativeTime()).result.current;
}

describe('useRelativeTime', () => {
  beforeEach(() => {
    language.current = 'en';
  });

  it('reads minutes, hours, days, months and years', () => {
    const f = format();
    expect(f(minutesAgo(44))).toBe('44 minutes ago');
    expect(f(minutesAgo(3 * 60))).toBe('3 hours ago');
    expect(f(minutesAgo(2 * 24 * 60))).toBe('2 days ago');
    expect(f(minutesAgo(70 * 24 * 60))).toBe('2 months ago');
    expect(f(minutesAgo(400 * 24 * 60))).toBe('last year');
  });

  it('calls anything under a minute "now"', () => {
    // A freshly published headline should not read "in 0 seconds".
    expect(format()(minutesAgo(0))).toBe('this minute');
  });

  it('speaks the user language, without a catalog string per locale', () => {
    // The whole reason for Intl over "{n}m ago" keys: plural rules are the
    // formatter's job, and Polish has three forms.
    language.current = 'pl';
    expect(format()(minutesAgo(44))).toContain('minut');
    expect(format()(minutesAgo(44))).not.toContain('minutes');
  });

  it('hands the pseudo-locale off to the runtime default', () => {
    // 'xx' is not a real Intl locale and would throw.
    language.current = 'xx';
    expect(() => format()(minutesAgo(5))).not.toThrow();
  });

  it('returns nothing for a missing or unusable timestamp', () => {
    const f = format();
    expect(f(null)).toBe('');
    expect(f(undefined)).toBe('');
    expect(f('not a date')).toBe('');
  });

  it('accepts a Date as well as a string', () => {
    expect(format()(new Date(Date.now() - 2 * 60 * 60 * 1000))).toBe(
      '2 hours ago',
    );
  });
});
