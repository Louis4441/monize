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

/** The lists that are a horizontal strip on a phone rather than a long column. */
const STRIPS = [
  { id: 'fgrid', what: 'the feature list' },
  { id: 'gal', what: 'the screenshot gallery' },
];

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
   * Two lists here are long -- twenty-eight feature cards and forty-two gallery
   * screenshots -- and one column of either is a couple of screens of
   * thumb-scrolling to reach the next section, so on a phone both are horizontal
   * strips. Three things have to line up, and any one of them alone leaves the
   * long column in place, which looks like nothing was changed rather than like
   * something is broken: the class in the markup, the rule in the phone
   * breakpoint, and that rule's selector actually reaching the element carrying
   * the class. The third is the one only a scan catches -- the rule names its
   * consumers (`.grid.strip,.gal.strip`) because a bare `.strip` would only beat
   * the collapse rules on source order, so a third list added to the markup is
   * styled by nothing until the selector grows to meet it.
   */
  it('turns its long lists into horizontal strips on a phone', () => {
    const html = markup(readFileSync(join(SITE, 'index.html'), 'utf8'));
    const strips = phoneRules(readFileSync(join(SITE, 'assets', 'css', 'styles.css'), 'utf8')).filter(({ selectors }) =>
      /(^|[\s,>+~])\.[A-Za-z0-9_.-]*\bstrip\b/.test(selectors),
    );
    const scrollers = strips.filter(({ declarations }) => /overflow-x\s*:\s*(auto|scroll)/.test(declarations));

    const required: Array<[RegExp, string]> = [
      [
        /display\s*:\s*grid/,
        'display:grid -- a multi-column container is not a grid container, so nothing else in the rule reaches the ' +
          "gallery's masonry",
      ],
      [/grid-auto-flow\s*:\s*column/, 'grid-auto-flow:column -- lays the items along one row instead of one per row'],
      [
        /grid-template-columns\s*:\s*none/,
        'grid-template-columns:none -- an explicit track list sizes the leading items and grid-auto-columns only ' +
          'picks up the implicit ones after it, so the collapsed 1fr would keep the first item full width',
      ],
      [
        /overflow-x\s*:\s*(auto|scroll)/,
        'overflow-x:auto -- without it the row is an overflow, not a scroller, and the items are simply unreachable',
      ],
      [/scroll-snap-type\s*:\s*x/, 'scroll-snap-type:x -- a swipe lands on an item rather than between two'],
    ];
    const declared = strips.map(({ declarations }) => declarations).join(';');
    const missing = required.flatMap(([pattern, why]) => (pattern.test(declared) ? [] : [why]));
    expect(missing, `the strip rule in the phone breakpoint is missing:\n  ${missing.join('\n  ')}`).toEqual([]);

    // Class-only selectors from the rule that makes a strip scroll, e.g.
    // `.grid.strip` -> ['grid', 'strip']. Anything with a combinator or an
    // element in it styles the items, not the container, and is skipped.
    const reaches = scrollers
      .flatMap(({ selectors }) => selectors.split(','))
      .map((selector) => selector.trim())
      .filter((selector) => /^(\.[A-Za-z0-9_-]+)+$/.test(selector))
      .map((selector) => selector.slice(1).split('.'));

    const unstyled = STRIPS.flatMap(({ id, what }) => {
      const tag = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
      if (!tag) return [`${what} (#${id}) is gone from index.html -- update this guard with it`];

      const classes = new Set((tag[0].match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean));
      if (!classes.has('strip')) return [`${what} (#${id}) must carry the strip class`];
      if (reaches.some((needed) => needed.every((name) => classes.has(name)))) return [];

      return [
        `${what} (#${id}) carries the strip class but no selector on the scrolling rule matches it -- it has ` +
          `${[...classes].join(', ')}, and the rule reaches ${reaches.map((n) => n.join('.')).join(' / ')}`,
      ];
    });

    expect(unstyled, unstyled.join('\n')).toEqual([]);
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
