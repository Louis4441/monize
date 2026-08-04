import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The marketing site's JavaScript builds every node with `document.createElement`
 * and text nodes -- it never assigns a built-up string to `innerHTML`.
 *
 * `website/assets/js/app.js` shipped with five `innerHTML` sinks that
 * interpolated the page's own content model into markup, and Bearer failed the
 * whole pipeline on them (CWE-79). The content is hardcoded, so nothing was
 * exploitable that day; the objection is that the shape is one edit away from
 * being exploitable, and the site has no build step, no framework escaping and
 * no CSP to fall back on. The fix was `el(tag, className, ...children)` plus
 * `fill()`/`clear()`, which cannot produce markup from data.
 *
 * The site is not covered by any other suite -- it is static files served
 * directly -- so this scan is the only thing standing between a future edit and
 * a red pipeline. It lives here because the frontend's Vitest is the nearest
 * JavaScript test runner, the same reason `dockerignore.test.ts` reaches out to
 * `backend/.dockerignore` from this directory.
 */
const WEBSITE_JS_DIR = join(__dirname, '..', '..', '..', 'website', 'assets', 'js');

/**
 * Block comments are stripped before scanning: the file documents the rule in
 * prose, and prose naming a sink must not be mistaken for one. No string
 * literal in these files contains a `/*` sequence, so this cannot swallow code.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const BANNED: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\.(inner|outer)HTML\s*=/,
    why: 'assigns to innerHTML/outerHTML -- build the node with el(...) and put it in place with fill()/clear() instead',
  },
  {
    pattern: /\binsertAdjacentHTML\s*\(/,
    why: 'parses a string as markup -- use el(...) and appendChild instead',
  },
  {
    pattern: /\bdocument\.write\s*\(/,
    why: 'parses a string as markup -- use el(...) and appendChild instead',
  },
  {
    pattern: /\bMath\.random\s*\(/,
    why: 'use the crypto-backed rnd() helper (CWE-330), even for decoration',
  },
  {
    // `document.createElement(t)` is a dynamic HTML sink to a scanner reading
    // the file: it cannot see that every call site passes a hardcoded tag.
    // Every tag goes through the literal constructors in the TAGS map.
    pattern: /\bdocument\.createElement\s*\(\s*(?!['"])/,
    why: 'createElement with a non-literal tag -- go through el(), whose TAGS map constructs each tag from a literal',
  },
];

function jsFiles(): string[] {
  return readdirSync(WEBSITE_JS_DIR).filter((name) => name.endsWith('.js'));
}

describe('website JavaScript builds DOM instead of parsing markup', () => {
  it('has files to scan', () => {
    // A guard that silently scans nothing passes forever. If the site moves,
    // this fails and whoever moved it updates the path.
    expect(jsFiles().length).toBeGreaterThan(0);
  });

  it.each(jsFiles())('%s uses no HTML-string sink and no Math.random', (name) => {
    const lines = code(readFileSync(join(WEBSITE_JS_DIR, name), 'utf8')).split('\n');

    const violations = lines.flatMap((line, i) =>
      BANNED.filter(({ pattern }) => pattern.test(line)).map(
        ({ why }) => `website/assets/js/${name}:${i + 1} ${why}\n    ${line.trim()}`,
      ),
    );

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
