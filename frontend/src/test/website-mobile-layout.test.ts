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

interface Rule {
  selectors: string;
  declarations: string;
}

/**
 * Every `selector { declarations }` pair in a stylesheet, at-rule bodies
 * included: `[^{}]+` cannot cross a brace, so an `@media` opener never matches
 * as a selector and the rules nested inside it are found on their own.
 */
function rules(css: string): Rule[] {
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(([, selectors, declarations]) => ({
    selectors: selectors.trim(),
    declarations,
  }));
}

/**
 * The rules that apply at the phone breakpoint. A regex cannot match a nested
 * brace pair, so the body of each `@media` is taken by counting braces out from
 * the one that opened it.
 */
function phoneRules(css: string): Rule[] {
  const stripped = code(css);
  const opener = /@media([^{]*)\{/g;
  const found: Rule[] = [];

  for (let at = opener.exec(stripped); at; at = opener.exec(stripped)) {
    const start = at.index + at[0].length;
    let end = start;
    for (let depth = 1; end < stripped.length && depth > 0; end++) {
      if (stripped[end] === '{') depth++;
      else if (stripped[end] === '}') depth--;
    }
    if (/max-width\s*:\s*640px/.test(at[1])) found.push(...rules(stripped.slice(start, end - 1)));
    opener.lastIndex = end;
  }

  return found;
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

  /**
   * The features section is twenty-eight cards. Collapsed to a single column it
   * is a screen and a half of thumb-scrolling to reach the next section, so on a
   * phone it is a horizontal strip instead. Two files have to agree for that to
   * happen -- the class in the markup and the rule in the phone breakpoint --
   * and either one alone leaves the long column back in place, looking like
   * nothing was changed rather than like something is broken.
   */
  it('turns the feature list into a horizontal strip on a phone', () => {
    const tag = markup(readFileSync(join(SITE, 'index.html'), 'utf8')).match(/<div[^>]*\bid="fgrid"[^>]*>/);
    expect(tag, 'the feature list (#fgrid) is gone from index.html -- update this guard with it').not.toBeNull();
    expect(
      tag![0],
      '#fgrid must carry the feat-strip class, which is what the phone breakpoint styles as a scroller',
    ).toMatch(/class="[^"]*\bfeat-strip\b/);

    const declared = phoneRules(readFileSync(join(SITE, 'assets', 'css', 'styles.css'), 'utf8'))
      .filter(({ selectors }) => /\bfeat-strip\b/.test(selectors))
      .map(({ declarations }) => declarations)
      .join(';');

    const required: Array<[RegExp, string]> = [
      [/grid-auto-flow\s*:\s*column/, 'grid-auto-flow:column -- lays the cards along one row instead of one per row'],
      [
        /grid-template-columns\s*:\s*none/,
        'grid-template-columns:none -- an explicit track list sizes the leading items and grid-auto-columns only ' +
          'picks up the implicit ones after it, so the collapsed 1fr would keep the first card full width',
      ],
      [
        /overflow-x\s*:\s*(auto|scroll)/,
        'overflow-x:auto -- without it the row is an overflow, not a scroller, and the cards are simply unreachable',
      ],
      [/scroll-snap-type\s*:\s*x/, 'scroll-snap-type:x -- a swipe lands on a card rather than between two'],
    ];

    const missing = required.flatMap(([pattern, why]) => (pattern.test(declared) ? [] : [why]));
    expect(missing, `the .feat-strip rule in the phone breakpoint is missing:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  /**
   * A horizontal scroller that reaches its end hands the rest of the gesture to
   * its ancestors, and on a phone the ancestor that takes it is the browser: a
   * swipe past the last feature card is a back-navigation off the site. Every
   * sideways scroller on the page has to keep its own overscroll.
   */
  it('keeps a sideways swipe inside the strip that receives it', () => {
    const css = code(readFileSync(join(SITE, 'assets', 'css', 'styles.css'), 'utf8'));
    const scrollers = rules(css).filter(({ declarations }) => /overflow-x\s*:\s*(auto|scroll)/.test(declarations));

    // A guard that silently scans nothing passes forever.
    expect(scrollers.length).toBeGreaterThan(0);

    const leaky = scrollers
      .filter(({ declarations }) => !/overscroll-behavior(-x)?\s*:\s*(contain|none)/.test(declarations))
      .map(
        ({ selectors }) =>
          `${selectors} scrolls horizontally without overscroll-behavior-x:contain -- a swipe past its end ` +
          'chains to the page and then to the browser gesture, which navigates away from the site',
      );

    expect(leaky, leaky.join('\n')).toEqual([]);
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
