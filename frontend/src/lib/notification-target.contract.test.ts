import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { safeNotificationTarget } from './notification-target';

/**
 * A notification's `target` is a claim about two things nothing else checks: the
 * app's route tree, and the rule that decides whether a target may be followed.
 *
 * Both have already been wrong. A BILL_DUE notification shipped with
 * `/scheduled-transactions/<id>`, which is not a route -- and because a stored
 * target WINS over the client's type table, the fix for "the bell should know
 * where to go" replaced a working destination with the not-found page. And the
 * rule itself exists twice: the service worker resolves a push payload's target
 * against the origin, while the app checks a stored one before `router.push`.
 * The worker is a classic script that cannot import app code, so the duplication
 * is forced by the platform -- what is not forced is the two answers drifting.
 */

const APP_DIR = resolve(__dirname, '../app');
const BACKEND_SRC = resolve(__dirname, '../../../backend/src');

// ---------------------------------------------------------------------------
// Every target a producer writes must resolve to a route
// ---------------------------------------------------------------------------

/** A backend file's contents with comments blanked, so prose cannot declare a target. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function backendFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return backendFiles(path);
    if (!path.endsWith('.ts') || path.endsWith('.spec.ts')) return [];
    return [path];
  });
}

/**
 * The literal `target:` values the backend assigns, as route patterns with each
 * `${...}` interpolation collapsed to a single dynamic segment.
 */
function producedTargets(): { file: string; target: string }[] {
  const found: { file: string; target: string }[] = [];
  for (const file of backendFiles(BACKEND_SRC)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(
      /\btarget:\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')/g,
    )) {
      const literal = match[1] ?? match[2] ?? match[3];
      // Only a path is a route claim. Anything else here is another `target`
      // (a Money field, a budget target amount) and is not this test's subject.
      if (!literal.startsWith('/')) continue;
      found.push({
        file: file.slice(BACKEND_SRC.length + 1),
        target: literal.replace(/\$\{[^}]*\}/g, ':param'),
      });
    }
  }
  return found;
}

/**
 * Whether a path pattern resolves to a page in the App Router, matching a
 * literal segment to a directory of that name and `:param` to a `[...]` one.
 */
function routeExists(pattern: string): boolean {
  const segments = pattern.split('?')[0].split('#')[0].split('/').filter(Boolean);
  let dir = APP_DIR;
  for (const segment of segments) {
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir).filter((entry) =>
      statSync(join(dir, entry)).isDirectory(),
    );
    const match =
      segment === ':param'
        ? entries.find((entry) => entry.startsWith('['))
        : entries.find((entry) => entry === segment);
    if (!match) return false;
    dir = join(dir, match);
  }
  return existsSync(join(dir, 'page.tsx'));
}

describe('every notification target resolves to a route', () => {
  const targets = producedTargets();

  it('finds the targets it is meant to check', () => {
    // A regex that stops matching, or a producer that stops writing targets,
    // would otherwise make the assertion below trivially true.
    expect(targets.length).toBeGreaterThan(0);
  });

  it('recognises the app router tree it checks against', () => {
    expect(routeExists('/bills')).toBe(true);
    expect(routeExists('/budgets/:param')).toBe(true);
    expect(routeExists('/scheduled-transactions/:param')).toBe(false);
  });

  it('resolves every produced target', () => {
    const broken = targets
      .filter(({ target }) => !routeExists(target))
      .map(({ file, target }) => `${file}: ${target}`);
    expect(broken).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The worker's rule and the app's rule agree on what may be followed
// ---------------------------------------------------------------------------

/**
 * `safeNotificationPath` out of the worker, evaluated the way the browser runs
 * it: a classic script in a sandbox, whose top-level function declarations land
 * on the contextified global.
 */
function loadWorkerRule(): (value: unknown) => string {
  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  const sandbox: Record<string, unknown> = {
    self: {
      addEventListener: () => {},
      skipWaiting: () => {},
      location: { origin: 'https://monize.test' },
      registration: { showNotification: async () => {}, pushManager: {} },
      clients: { claim: () => {}, matchAll: async () => [], openWindow: async () => {} },
    },
    caches: { open: async () => ({}), match: async () => undefined, keys: async () => [] },
    fetch: async () => ({}),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    // A vm context has its own globals and does NOT inherit the host's, so the
    // worker's `new URL(...)` throws `URL is not defined` and its catch answers
    // `/` for every input -- a harness that agrees with nothing while looking
    // like it agrees with everything.
    URL,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const rule = sandbox.safeNotificationPath;
  if (typeof rule !== 'function') {
    throw new Error(
      'safeNotificationPath was not found on the worker global -- this guard has lost its subject',
    );
  }
  return rule as (value: unknown) => string;
}

/**
 * The verdicts that must match. The worker answers `/` for a refusal and a
 * normalised path for an acceptance; the app answers `null` and the value.
 * Comparing the verdict rather than the string is what makes them comparable at
 * all -- and what the two must never disagree about, because one notification
 * is reachable through both surfaces.
 */
const SHARED_CASES: readonly { name: string; value: string; follow: boolean }[] = [
  { name: 'a plain path', value: '/budgets/b-1', follow: true },
  { name: 'a path with a query and hash', value: '/bills?due=today#top', follow: true },
  { name: 'the root', value: '/', follow: true },
  { name: 'protocol-relative', value: '//evil.example/steal', follow: false },
  { name: 'backslash protocol-relative', value: '/\\evil.example/steal', follow: false },
  { name: 'an absolute https URL', value: 'https://evil.example/steal', follow: false },
  { name: 'a scheme', value: 'javascript:alert(1)', follow: false },
  { name: 'a relative path', value: 'budgets/b-1', follow: false },
  { name: 'empty', value: '', follow: false },
];

describe('the worker and the app agree on what may be followed', () => {
  const workerRule = loadWorkerRule();

  it('loads a working rule, not one that refuses everything', () => {
    // A vm context has its own globals: without `URL` in the sandbox the
    // worker's catch answers `/` for every input, and every agreement
    // assertion below would pass for the wrong reason.
    expect(workerRule('/budgets/b-1')).toBe('/budgets/b-1');
    expect(workerRule('//evil.example')).toBe('/');
  });

  it.each(SHARED_CASES)('$name', ({ value, follow }) => {
    expect(safeNotificationTarget(value) !== null).toBe(follow);
    expect(workerRule(value) !== '/' || value === '/').toBe(follow);
  });

  /**
   * The two places they deliberately differ, pinned so a change to either side
   * has to come here and say so.
   *
   * Neither is reachable for a STORED target: the write door caps `target` at
   * the column's 255 characters and every producer writes a leading slash. They
   * are reachable for a PUSH PAYLOAD, which is why the worker is the stricter of
   * the two -- it is the surface an external push service can influence.
   */
  it('differs only on the payload-only cases, and in the safe direction', () => {
    const tooLong = `/${'a'.repeat(600)}`;
    expect(workerRule(tooLong)).toBe('/');
    expect(safeNotificationTarget(tooLong)).toBe(tooLong);

    const withTab = '/\thttps://x';
    expect(workerRule(withTab)).toBe('/https://x');
    expect(safeNotificationTarget(withTab)).toBe(withTab);
  });
});
