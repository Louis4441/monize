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
 *  - a two-column hero collapsing to one put its screenshot last, below four
 *    stat tiles and roughly a screen and a half down. Reported as the site
 *    having no picture on mobile, which is what a picture nobody reaches is.
 *
 * It lives here for the same reason `website-dom-safety.test.ts` does: the
 * frontend's Vitest is the nearest JavaScript test runner to `website/`.
 */
const SITE = join(__dirname, '..', '..', '..', 'website');

/** The lists that are a horizontal strip on a phone rather than a long column. */
const STRIPS = [
  { id: 'fgrid', what: 'the feature list' },
  { id: 'gal', what: 'the screenshot gallery' },
  { id: 'repGrid', what: 'the reports list' },
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
 * The rules inside every `@media` whose `max-width` the caller accepts. A regex
 * cannot match a nested brace pair, so the body of each `@media` is taken by
 * counting braces out from the one that opened it.
 */
function mediaRules(css: string, accepts: (maxWidth: number) => boolean): Rule[] {
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
    const max = at[1].match(/max-width\s*:\s*(\d+)px/);
    if (max && accepts(Number(max[1]))) found.push(...rules(stripped.slice(start, end - 1)));
    opener.lastIndex = end;
  }

  return found;
}

/** The rules that apply at the phone breakpoint. */
function phoneRules(css: string): Rule[] {
  return mediaRules(css, (maxWidth) => maxWidth === 640);
}

/**
 * The rules outside every at-rule, i.e. the ones that apply at any width. A
 * bare `rules()` over the whole sheet reaches inside `@media` bodies too --
 * `[^{}]+` never matches the `@media` opener itself, so its children are
 * indistinguishable from top-level rules once they are in the list.
 */
function topLevelRules(css: string): Rule[] {
  const stripped = code(css);
  const opener = /@[a-z-]+[^{;]*\{/gi;
  const kept: string[] = [];
  let from = 0;

  for (let at = opener.exec(stripped); at; at = opener.exec(stripped)) {
    kept.push(stripped.slice(from, at.index));
    let end = at.index + at[0].length;
    for (let depth = 1; end < stripped.length && depth > 0; end++) {
      if (stripped[end] === '{') depth++;
      else if (stripped[end] === '}') depth--;
    }
    from = end;
    opener.lastIndex = end;
  }
  kept.push(stripped.slice(from));

  return rules(kept.join('\n'));
}

function styles(): string {
  return readFileSync(join(SITE, 'assets', 'css', 'styles.css'), 'utf8');
}

/** Track count for a `grid-template-rows` value, `repeat(n, ...)` included. */
function trackCount(value: string): number {
  const repeat = value.match(/repeat\(\s*(\d+)\s*,([^)]*)\)/);
  const list = (repeat ? repeat[2] : value).trim().split(/\s+/).filter(Boolean).length;
  return repeat ? Number(repeat[1]) * list : list;
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
   * Three lists here are long -- twenty-eight feature cards, forty-two gallery
   * screenshots and forty-six report rows -- and one column of any of them is a
   * couple of screens of thumb-scrolling to reach the next section, so on a
   * phone all three are horizontal
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
   * A report row is one line of text and a category, not a card with a picture
   * in it, so the shared strip rule on its own -- a single row of 82%-wide
   * columns -- leaves most of the strip's height empty and still costs one swipe
   * per report. Stacking them four to a column is the difference between twelve
   * swipes and forty-six, and it is the declaration a browser needs told
   * explicitly: with `grid-auto-flow:column` the implicit grid grows sideways,
   * so without a row track list every item lands in row one. That arrangement
   * satisfies every assertion above, which is why it needs its own.
   */
  it('stacks the reports strip several rows deep', () => {
    const declared = phoneRules(readFileSync(join(SITE, 'assets', 'css', 'styles.css'), 'utf8'))
      .filter(({ selectors }) =>
        selectors.split(',').some((s) => /\.rep-grid\b/.test(s) && /\bstrip\b/.test(s) && !/[\s>+~]/.test(s.trim())),
      )
      .flatMap(({ declarations }) =>
        Array.from(declarations.matchAll(/grid-template-rows\s*:([^;}]*)/g)).map(([, value]) => value.trim()),
      );

    expect(
      declared,
      'the reports strip declares no grid-template-rows inside the phone breakpoint -- under grid-auto-flow:column ' +
        'that puts all forty-six reports in a single row, one swipe each, with the rest of the strip blank',
    ).not.toEqual([]);

    const deepest = Math.max(...declared.map(trackCount));
    expect(
      deepest,
      `the reports strip lays out ${deepest} row(s) of reports (${declared.join(', ')}) -- one row per column is the ` +
        'shape this guard exists to catch',
    ).toBeGreaterThan(1);
  });

  /**
   * The header is a brand, a theme toggle, a demo button and a menu button on
   * one flex line, and below about 380px that line is wider than the screen.
   * Nothing in it gives -- `.btn` is `white-space:nowrap` and `.icobtn` is a
   * fixed square -- so the whole shortfall came out of `.brand`, which does not
   * reflow: it slid its own text under the theme toggle. At 320px the wordmark
   * read "Moniz" and the menu button, the only way to reach the nav once `#nav`
   * is `display:none`, hung 11px past the right edge. Not merely scrolled off:
   * `body` sets `overflow-x:hidden` and, with `html` at visible, that propagates
   * to the viewport, so the button was clipped away entirely. Measured in
   * Chromium, the header held a hard 331px floor at every viewport below it.
   *
   * The layout result cannot be scanned, so these are the three declarations
   * that keep it true. The third is the one that is easy to get wrong twice:
   * the lightbox's close and arrow buttons carry `.icobtn` too, and they are
   * thumb targets over a photo, so a header-sized override has to name the
   * header.
   */
  it('keeps the whole header inside the narrowest phone', () => {
    const css = styles();
    const narrow = mediaRules(css, (maxWidth) => maxWidth <= 560);

    const brandHolds = narrow.some(
      ({ selectors, declarations }) =>
        selectors.split(',').some((selector) => selector.trim() === '.brand') &&
        (/(^|[;\s])flex\s*:\s*0\s+0\b/.test(declarations) || /(^|[;\s])flex-shrink\s*:\s*0/.test(declarations)),
    );
    expect(
      brandHolds,
      '.brand must stop shrinking at the phone breakpoint (flex:0 0 auto, or flex-shrink:0). It is the only ' +
        'flexible item on the header line, so without this every pixel the header is over budget is taken out of ' +
        'the wordmark -- which does not wrap, it slides under the control beside it and renders as "Moniz".',
    ).toBe(true);

    const wordmarkGoes = mediaRules(css, (maxWidth) => maxWidth <= 400).some(
      ({ selectors, declarations }) =>
        /\.brand\s+span\b/.test(selectors) && /(^|[;\s])display\s*:\s*none/.test(declarations),
    );
    expect(
      wordmarkGoes,
      'no breakpoint at or below 400px hides .brand span. Even with the gutters tightened the wordmark does not ' +
        'fit beside the demo button and the two icon buttons on a 320-360px screen, and it is the element whose ' +
        'loss costs least -- the logo is still the link home and still carries the accessible name.',
    ).toBe(true);

    const unscoped = narrow
      .filter(({ declarations }) => /(^|[;\s])(width|height)\s*:/.test(declarations))
      .flatMap(({ selectors }) => selectors.split(','))
      .map((selector) => selector.trim())
      .filter((selector) => /(^|[\s>+~])\.icobtn\b/.test(selector) && !/#hdr|\.hdr-cta/.test(selector));
    expect(
      unscoped,
      `${unscoped.join(', ')} resizes an icon button at a phone breakpoint without naming the header. The lightbox's ` +
        'close and previous/next buttons carry that class as well, and they are thumb targets sitting over a ' +
        'photo -- shrink the header pair with .hdr-cta .icobtn instead.',
    ).toEqual([]);
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

  /**
   * The hero is two columns of copy and screenshot on a desktop and one column
   * on a phone, and stacking it put the picture last -- under the badge, the
   * headline, the lede, both buttons, the fine print and four stat tiles, about
   * a screen and a half below the fold. A hero image nobody scrolls to is a
   * hero image nobody sees, and the report it produced was that the marketing
   * site has no picture on mobile rather than that it is in the wrong place.
   *
   * So the copy is two blocks with the art between them, and the fix is only
   * held by the named areas: drop `grid-template-areas` from either breakpoint
   * and the three children fall straight back into document order, which looks
   * deliberate and is the original defect at the desktop end. Both orders are
   * checked here -- the phone's, because that is the bug, and the desktop's,
   * because the split is invisible there only while the art spans both rows.
   */
  it('puts the hero screenshot between the lede and the buttons on a phone', () => {
    const html = markup(readFileSync(join(SITE, 'index.html'), 'utf8'));
    const hero = html.match(/<div class="wrap hero-grid">([\s\S]*?)\n {2}<\/div>/);
    expect(hero, 'the hero grid is gone from index.html -- update this guard with it').not.toBeNull();

    const regions = ['hero-copy-top', 'hero-art', 'hero-copy-bottom'];
    const inMarkup = regions.filter((region) => new RegExp(`class="${region}"`).test(hero![1]));
    expect(
      inMarkup,
      `the hero must be ${regions.join(', ')} -- one block of copy cannot have the picture inserted into the ` +
        'middle of it, and splitting the copy is what lets the phone layout place the picture after the lede',
    ).toEqual(regions);

    /** The area names of a `grid-template-areas` value, row by row. */
    const areaRows = (declarations: string): string[][] =>
      Array.from(declarations.match(/grid-template-areas\s*:([^;}]*)/)?.[1].matchAll(/"([^"]*)"/g) ?? []).map(
        ([, row]) => row.trim().split(/\s+/),
      );

    /** The last `grid-template-areas` `.hero-grid` is given among `candidates`. */
    const heroAreas = (candidates: Rule[], where: string): string[][] => {
      const declared = candidates
        .filter(({ selectors }) => selectors.split(',').some((s) => s.trim() === '.hero-grid'))
        .map(({ declarations }) => areaRows(declarations))
        .filter((rows) => rows.length > 0);

      expect(
        declared.length,
        `.hero-grid declares no grid-template-areas ${where}. Without it the three hero blocks fall back to ` +
          'document order, and the copy split silently does nothing.',
      ).toBeGreaterThan(0);
      return declared[declared.length - 1];
    };

    // The stacking breakpoint: one column, the picture in the middle row.
    const phone = heroAreas(
      mediaRules(styles(), (maxWidth) => maxWidth === 1020),
      'at the 1020px stacking breakpoint',
    );
    expect(
      phone.map((row) => row.join(' ')),
      'stacked, the hero must read copyTop / art / copyBottom -- the picture belongs after the headline and lede ' +
        'and before the call-to-action row, not below the stats where it started',
    ).toEqual(['copyTop', 'art', 'copyBottom']);

    // Wide: both copy rows in column one, the art spanning them in column two.
    const wide = heroAreas(topLevelRules(styles()), 'outside a media query (the desktop layout)');
    expect(
      wide.map((row) => row.join(' ')),
      'side by side, the copy stacks in the first column and the art spans both rows of the second -- anything ' +
        'else leaves a gap beside one of the two copy blocks',
    ).toEqual(['copyTop art', 'copyBottom art']);

    // The split must cost nothing where the copy is one column: a row gap
    // between the two blocks would open a space that was never there before.
    const gapless = topLevelRules(styles()).some(
      ({ selectors, declarations }) =>
        selectors.split(',').some((s) => s.trim() === '.hero-grid') && /(^|[;\s])row-gap\s*:\s*0/.test(declarations),
    );
    expect(
      gapless,
      '.hero-grid must set row-gap:0 in its base rule. The two copy blocks are one continuous column of text on a ' +
        'desktop, and a grid gap between them is spacing the single block never had.',
    ).toBe(true);
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
