import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The proxy's request-body ceiling, guarded because it fails silently.
 *
 * Every `/api/*` call is forwarded by `proxy.ts`, and Next caps a proxied
 * request body at 10MB by default. It does not reject an oversized upload -- it
 * truncates the body, forwards the stump, and the backend logs an aborted
 * request. Nothing in the wizard, the API client or the backend says "too
 * large", so a Microsoft Money file over 10MB failed with a stack trace about a
 * dropped socket. Every committed `.mny` fixture is a few MB, so no test in this
 * repository could have caught it; a real 60MB file did.
 *
 * The ceiling therefore has to stay at or above the backend's own upload limit.
 * Resolved in a child process because `next.config.js` loads the next-intl
 * plugin, which cannot be required under the jsdom environment these tests use.
 */
describe('proxy request body limit', () => {
  const experimental = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        'Promise.resolve(require(process.argv[1])).then((c) => console.log(JSON.stringify(c.experimental ?? {})))',
        join(process.cwd(), 'next.config.js'),
      ],
      { encoding: 'utf8' },
    ),
  ) as Record<string, unknown>;

  function limitMb(value: unknown): number {
    if (typeof value === 'number') return value / (1024 * 1024);
    const match = /^(\d+(?:\.\d+)?)mb$/i.exec(String(value ?? ''));
    return match ? Number(match[1]) : Number.NaN;
  }

  it('raises the ceiling above Next’s 10MB default', () => {
    expect(limitMb(experimental.proxyClientMaxBodySize)).toBeGreaterThan(10);
  });

  it('covers the backend upload limit, which defaults to 300MB', () => {
    // Same variable name as the backend's, so lowering one lowers both.
    const importLimit = Number(process.env.MNY_IMPORT_LIMIT_MB) || 300;

    expect(limitMb(experimental.proxyClientMaxBodySize)).toBeGreaterThanOrEqual(
      importLimit,
    );
  });

  it('uses the non-deprecated option name', () => {
    // `middlewareClientMaxBodySize` still works and is what Next's own warning
    // names, but it is deprecated in favour of the proxy-era key.
    expect(experimental.middlewareClientMaxBodySize).toBeUndefined();
    expect(experimental.proxyClientMaxBodySize).toBeDefined();
  });
});
