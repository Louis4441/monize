import { describe, it, expect } from 'vitest';
import { safeNotificationTarget } from './notification-target';

describe('safeNotificationTarget', () => {
  it('accepts a same-origin path', () => {
    expect(safeNotificationTarget('/budgets/b-1')).toBe('/budgets/b-1');
    expect(safeNotificationTarget('/bills?due=today#top')).toBe(
      '/bills?due=today#top',
    );
  });

  it('treats absent, empty and non-string as no target', () => {
    expect(safeNotificationTarget(null)).toBeNull();
    expect(safeNotificationTarget(undefined)).toBeNull();
    expect(safeNotificationTarget('')).toBeNull();
    expect(safeNotificationTarget(42 as unknown as string)).toBeNull();
  });

  // Each of these reaches a different origin while looking like a path to a
  // reader skimming the value.
  it.each([
    ['protocol-relative', '//evil.example/steal'],
    ['backslash protocol-relative', '/\\evil.example/steal'],
    ['absolute https', 'https://evil.example/steal'],
    ['scheme only', 'javascript:alert(1)'],
    ['relative', 'budgets/b-1'],
  ])('refuses a %s target', (_case, target) => {
    expect(safeNotificationTarget(target)).toBeNull();
  });

  // Refuses rather than repairs: a target we cannot vouch for is dropped, not
  // rewritten into something the producer did not mean.
  it('does not normalise a refused target into a path', () => {
    expect(safeNotificationTarget('https://evil.example/budgets/b-1')).toBeNull();
  });
});
