import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NOTIFICATION_PREFERENCE_CATEGORIES } from './notification-preferences';

/**
 * The matrix categories are mirrored by hand across the layers (nothing
 * compiles the frontend against the backend). If the backend exposes a new
 * category and this list does not grow with it, the settings matrix silently
 * omits a toggle the API now honours -- so hold the two equal.
 */
const BACKEND_SERVICE = resolve(
  __dirname,
  '../../../backend/src/notification-center/notification-preference.service.ts',
);

function parseBackendCategories(): string[] {
  const source = readFileSync(BACKEND_SERVICE, 'utf8');
  const block = source.match(
    /NOTIFICATION_PREFERENCE_CATEGORIES[^=]*=\s*\[([^\]]*)\]/,
  );
  if (!block) throw new Error('backend NOTIFICATION_PREFERENCE_CATEGORIES not found');
  return [...block[1].matchAll(/NotificationCategory\.(\w+)/g)].map((m) => m[1]);
}

describe('notification preferences contract', () => {
  it('exposes exactly the categories the backend does, in order', () => {
    expect(parseBackendCategories()).toEqual([
      ...NOTIFICATION_PREFERENCE_CATEGORIES,
    ]);
  });
});
