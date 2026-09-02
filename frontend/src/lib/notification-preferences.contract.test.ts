import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  NOTIFICATION_CATEGORY_CHANNELS,
  type CategoryChannelSupport,
} from './notification-preferences';

/**
 * The matrix categories and their per-category channel support are mirrored by
 * hand across the layers (nothing compiles the frontend against the backend).
 * If the backend exposes a new category, or changes which channels a category
 * exposes, and these copies do not follow, the settings matrix silently draws a
 * toggle the API forces off (or omits one it now honours) -- so hold both equal.
 */
const BACKEND_SERVICE = resolve(
  __dirname,
  '../../../backend/src/notification-center/notification-preference.service.ts',
);

function backendSource(): string {
  return readFileSync(BACKEND_SERVICE, 'utf8');
}

function parseBackendCategories(): string[] {
  const block = backendSource().match(
    /NOTIFICATION_PREFERENCE_CATEGORIES[^=]*=\s*\[([^\]]*)\]/,
  );
  if (!block) throw new Error('backend NOTIFICATION_PREFERENCE_CATEGORIES not found');
  return [...block[1].matchAll(/NotificationCategory\.(\w+)/g)].map((m) => m[1]);
}

function parseBackendChannelSupport(): Record<string, CategoryChannelSupport> {
  const source = backendSource();
  const block = source.match(
    /NOTIFICATION_CATEGORY_CHANNELS[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
  );
  if (!block) throw new Error('backend NOTIFICATION_CATEGORY_CHANNELS not found');
  const out: Record<string, CategoryChannelSupport> = {};
  for (const entry of block[1].matchAll(
    /\[NotificationCategory\.(\w+)\]:\s*\{([^}]*)\}/g,
  )) {
    const [, category, body] = entry;
    const bool = (field: string): boolean => {
      const m = body.match(new RegExp(`${field}:\\s*(true|false)`));
      if (!m) throw new Error(`backend ${category}.${field} not found`);
      return m[1] === 'true';
    };
    out[category] = {
      email: bool('email'),
      emailNotification: bool('emailNotification'),
      push: bool('push'),
    };
  }
  return out;
}

describe('notification preferences contract', () => {
  it('exposes exactly the categories the backend does, in order', () => {
    expect(parseBackendCategories()).toEqual([
      ...NOTIFICATION_PREFERENCE_CATEGORIES,
    ]);
  });

  it('mirrors the backend per-category channel support exactly', () => {
    expect(NOTIFICATION_CATEGORY_CHANNELS).toEqual(parseBackendChannelSupport());
  });
});
