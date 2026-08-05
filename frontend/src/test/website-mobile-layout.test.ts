import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The marketing site is three static files with no build step, no framework and
 * no test runner of its own, so the only way a layout rule holds is a scan. Each
 * pattern here is a defect a human found on a phone:
 *
 *  - `scrollIntoView` in the tour's filmstrip scrolled every scrollable ancestor
 *    up to the document, and the tour's first paint happens while the section is
 *    still far below the fold -- so the site opened roughly halfway down itself.
 *  - `grid-template-columns` in a style attribute outranks every media query, so
 *    the self-hosting section kept two ~160px columns on a 390px screen after
 *    `.g2` had been told to collapse.
 *  - a viewport-relative `max-width` inside a padded overlay is wider than the
 *    box holding it by exactly that padding: the lightbox image overflowed its
 *    figure to the right while the caption stayed centred.
 *  - and underneath that one, a `1fr` track taking its automatic minimum from
 *    the tour filmstrip's whole unscrolled length, which made the document
 *    868px wide on a 390px screen. Every `position:fixed` overlay sizes to that
 *    containing block, so the lightbox centred its picture at x=434 -- two
 *    thirds of it past the right-hand edge of the phone.
 *
 * It lives here for the same reason `website-dom-safety.test.ts` does: the
 * frontend's Vitest is the nearest JavaScript test runner to `website/`.
 */
const SITE = join(__dirname, '..', '..', '..', 'website');

/**
 * Comments are stripped before scanning. Each rule below is written down in
 * prose next to the code it governs, and prose naming a banned pattern must not
 * be mistaken for one.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}
/**
 * Cutting HTML comments out by index rather than by `replace(/<!--.*?-->/g)`:
 * one pass of that regex leaves a `<!--` behind on `<!--<!-- -->`, which is the
 * incomplete-multi-character-sanitization shape CodeQL fails the build on. An
 * unterminated comment swallows the rest of the file, which is what a browser
 * does with one too.
 */
function markup(source: string): string {
  const kept: string[] = [];
  let from = 0;
  for (;;) {
    const open = source.indexOf('<!--', from);
    if (open < 0) {
      kept.push(source.slice(from));
      return kept.join('');
    }
    kept.push(source.slice(from, open));
    const close = source.indexOf('-->', open + 4);
    if (close < 0) return kept.join('');
    from = close + 3;
  }
}

function filesIn(dir: string, ext: string): string[] {
  return readdirSync(join(SITE, dir))
    .filter((name) => name.endsWith(ext))
    .map((name) => join(dir, name));
}

function scan(files: string[], strip: (s: string) => string, pattern: RegExp, why: string): void {
  // A guard that silently scans nothing passes forever.
  expect(files.length).toBeGreaterThan(0);

  const violations = files.flatMap((file) =>
    strip(readFileSync(join(SITE, file), 'utf8'))
      .split('\n')
      .flatMap((line, i) =>
        pattern.test(line) ? [`website/${file.replace(/\\/g, '/')}:${i + 1} ${why}\n    ${line.trim()}`] : [],
      ),
  );

  expect(violations, violations.join('\n')).toEqual([]);
}

describe('website layout holds on a phone', () => {
  it('scrolls its own containers, never the page', () => {
    scan(
      filesIn(join('assets', 'js'), '.js'),
      code,
      /\bscrollIntoView\s*\(/,
      'scrollIntoView scrolls every scrollable ancestor including the document, so a strip-local scroll during the first paint drags the whole page down to it -- move the container\'s own scrollLeft/scrollTop instead',
    );
  });

  it('declares column tracks in the stylesheet, not in a style attribute', () => {
    const files = filesIn('.', '.html');
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) => {
      const source = markup(readFileSync(join(SITE, file), 'utf8'));
      return Array.from(source.matchAll(/style\s*=\s*"([^"]*)"/g))
        .filter(([, decls]) => /(^|[;\s])(grid-template-)?columns\s*:/.test(decls))
        .map(
          ([, decls]) =>
            `website/${file.replace(/^\.[\\/]/, '')} declares a column layout inline -- an inline declaration outranks every media query, so the responsive breakpoints cannot collapse it. Move it to a class in styles.css.\n    style="${decls}"`,
        );
    });

    expect(violations, violations.join('\n')).toEqual([]);
  });

  /**
   * The scan a regex cannot do is "no element is wider than the screen" -- that
   * is a layout result, and the site has no browser harness. This checks the one
   * declaration that keeps it true instead: a layout grid whose items cannot
   * shrink below their content width has no defence against a horizontal
   * scroller inside it. A grid added to this list here is a grid the stylesheet
   * has to name too.
   */
  it('lets every layout grid shrink below its content', () => {
    const css = readFileSync(join(SITE, 'assets', 'css', 'styles.css'), 'utf8');
    const shrinkable = new Set(
      Array.from(code(css).matchAll(/([^{}]+)\{[^{}]*min-width\s*:\s*0[^{}]*\}/g)).flatMap(([, selectors]) =>
        selectors.split(',').map((s) => s.trim()),
      ),
    );

    const missing = ['.grid', '.hero-grid', '.tour', '.chat'].filter((grid) => !shrinkable.has(`${grid}>*`));

    expect(
      missing,
      `${missing.join(', ')} must appear in the min-width:0 rule in styles.css. A 1fr track takes its ` +
        'automatic minimum from the item\'s min-content width, so one horizontally scrolling child reports its ' +
        'whole unscrolled length there and widens the document past the phone -- which moves every ' +
        'position:fixed overlay with it.',
    ).toEqual([]);
  });

  it('sizes elements against their container, not the viewport', () => {
    scan(
      filesIn(join('assets', 'css'), '.css'),
      code,
      // A `vw` length is always preceded by a digit or a decimal point, and
      // `\b` does not match between the two -- `94vw` is one word to a regex.
      /max-width\s*:[^;}]*[\d.]vw\b/,
      'a viewport-relative max-width ignores the padding and scrollbar of whatever contains the element, so it overflows by exactly that much -- size against the container with a percentage',
    );
  });
});
