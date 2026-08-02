import { describe, it, expect } from 'vitest';

/**
 * Guard tests for the UI conventions in `frontend/CLAUDE.md`.
 *
 * These exist because a documented rule is only as good as its enforcement. Each
 * one was added after an agent reached for the generic solution, a human spotted
 * it in the running app, and the fix landed in a single file. A test that scans
 * the whole source tree catches the next instance wherever it appears, which a
 * test around the one component that was fixed cannot.
 *
 * Add a case here whenever a *mechanical* mistake gets corrected -- a raw element
 * used where a shared component exists. Judgement calls (is this list long enough
 * to need paging?) stay in prose; only checkable rules belong here.
 *
 * Modelled on `src/lib/tours/anchors.uniqueness.test.ts`, which scans the tree the
 * same way for detached tour anchors.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Source files only: tests legitimately contain the markup they assert on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

describe('date entry goes through DateInput', () => {
  /** The one file allowed to hold a raw date input -- it *is* the wrapper. */
  const WRAPPER = '/src/components/ui/DateInput.tsx';
  const RAW_DATE_INPUT = /type=["']date["']/;

  it('has no raw <input type="date"> outside the shared component', () => {
    const offenders = productionSources()
      .filter(([path]) => path !== WRAPPER)
      .filter(([, content]) => RAW_DATE_INPUT.test(content))
      .map(([path]) => path);

    // A bare date input misses the locale-aware parsing and `CalendarPopover`,
    // and shows the browser's own calendar icon beside Monize's -- the
    // `.date-picker-hide` rule in globals.css exists to suppress exactly that.
    expect(offenders).toEqual([]);
  });

  it('still finds the wrapper, so the rule cannot pass by accident', () => {
    // Were DateInput renamed, or were it to stop using a native date input, the
    // check above would trivially pass over an empty set. This fails first and
    // says what to update.
    const wrapper = sources[WRAPPER];
    expect(
      wrapper,
      `${WRAPPER} not found -- update WRAPPER in this test`,
    ).toBeTruthy();
    expect(RAW_DATE_INPUT.test(wrapper)).toBe(true);
  });
});

describe('a scrollbar you need is not hidden', () => {
  /**
   * `scrollbar-hide` is for a horizontal strip of chips, where the content being
   * cut off is itself the signal that there is more. On a vertical list it hides
   * the only indication that rows exist below the fold, which is strictly worse
   * than the plain bar someone was trying to get rid of. The fix for an ugly bar
   * is `scrollbar-slim`, not no bar.
   *
   * Matched per class attribute rather than per file, so an unrelated
   * `scrollbar-hide` elsewhere in the same component does not trip it.
   */
  const CLASS_ATTR = /class(?:Name)?=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

  it('never puts scrollbar-hide on a vertically scrolling element', () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(CLASS_ATTR)) {
        const classes = match[1] ?? match[2] ?? match[3] ?? '';
        if (
          classes.includes('scrollbar-hide') &&
          /\boverflow-y-(auto|scroll)\b/.test(classes)
        ) {
          offenders.push(`${path}: ${classes.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('chart colours come from the theme tokens', () => {
  /**
   * `src/lib/chart-colors.ts` exposes `var(--chart-*)` strings so a chart
   * follows the active colour theme and light/dark mode with no JS. A literal
   * `fill="#22c55e"` looks correct on the default palette and then stays that
   * exact green on all twenty-odd themes -- the charts were the last thing on
   * screen still doing it.
   *
   * Matched per colour prop rather than per file, because the same components
   * legitimately hold hex for the PDF export: `pdf-export.ts` parses
   * `summaryCards[].color` as hex, and a `var(...)` there produces NaN. Those
   * are `color:` keys and never reach a chart.
   *
   * The value is captured whole (`{...}`, `"..."`, `'...'`) so a conditional
   * like `fill={up ? '#16a34a' : '#dc2626'}` is caught too, not just the
   * literal-valued form.
   */
  const COLOUR_PROP = /\b(fill|stroke|stopColor)\s*[=:]\s*(\{[^{}]*\}|"[^"]*"|'[^']*')/g;
  const HEX = /#[0-9a-fA-F]{3,8}\b/;

  /**
   * Drawn on top of a filled flag bubble rather than on the card, so these are
   * contrast against the fill -- white is the point. `chartColors.surface`
   * would make them the card colour and so invisible on the bubble in dark
   * mode. The only exemption; anything new needs its own reason here.
   */
  const ON_FILL_WHITE = '/src/components/investments/portfolio-chart-utils.tsx';

  it('never hardcodes a hex colour on a chart fill or stroke', () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (!/from ['"]recharts['"]/.test(content)) continue;
      for (const match of content.matchAll(COLOUR_PROP)) {
        if (!HEX.test(match[2])) continue;
        // The bubble text/divider/cross, and nothing else in that file.
        if (path === ON_FILL_WHITE && /#fff\b/.test(match[2])) continue;
        offenders.push(`${path}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still matches the colour props it is meant to police', () => {
    // Were the regex to stop matching -- a Recharts rename, a bad edit -- the
    // check above would pass over an empty set. This fails first and says so.
    const sample = `fill="#22c55e" stroke={up ? '#16a34a' : '#dc2626'}`;
    const hits = [...sample.matchAll(COLOUR_PROP)].filter((m) => HEX.test(m[2]));
    expect(hits).toHaveLength(2);
  });
});

describe('a control sitting beside an input is the height of that input', () => {
  /**
   * `CurrencyPickerButton` is the square button left of an Amount field. It has
   * no vertical padding and no height of its own, so its height comes entirely
   * from the flex row. That made it a two-part rule that was easy to half-apply:
   * the button needs `self-stretch`, and the row it sits in needs
   * `items-stretch` with a `min-w-0` sibling. Getting either wrong renders a
   * squat button beside a full-height input, which is what a human had to point
   * out on the Bills & Deposits form.
   *
   * Both halves are checked: `self-stretch` on the button makes it correct
   * whatever the wrapper does, and the row check keeps the two existing call
   * sites (and any new one) on the same layout.
   */
  const BUTTON = '/src/components/transactions/CurrencyPickerButton.tsx';

  it('gives CurrencyPickerButton self-stretch, so any wrapper renders it full height', () => {
    const source = sources[BUTTON];
    expect(source, `${BUTTON} not found -- update BUTTON in this test`).toBeTruthy();
    // Guard against the class being dropped in a future restyle: align-self
    // beats the parent's align-items, so this is what makes the button
    // independent of how it is laid out.
    expect(source).toMatch(/className="[^"]*\bself-stretch\b/);
  });

  it('renders the picker only inside an items-stretch row', () => {
    const ROW = /<div className="flex items-stretch space-x-2">/;
    // Building the picker and handing it down as `currencyPickerSlot={...}` is
    // not laying it out -- TransactionForm does exactly that, and the row lives
    // in NormalTransactionFields / SplitTransactionFields, which receive it. So
    // a file that passes the slot on is a producer, and the check applies to
    // whoever actually renders it beside an input.
    const HANDS_OFF = /currencyPickerSlot=\{/;
    const offenders = productionSources()
      .filter(([path]) => path !== BUTTON)
      .filter(
        ([, content]) =>
          /<CurrencyPickerButton\b/.test(content) || /\{currencyPickerSlot\}/.test(content),
      )
      .filter(([, content]) => !HANDS_OFF.test(content))
      .filter(([, content]) => !ROW.test(content))
      .map(([path]) => path);

    // `items-start` (or the default `stretch` being overridden) leaves the
    // button at its content height. Use the same row the other call sites do.
    expect(offenders).toEqual([]);
  });
});
