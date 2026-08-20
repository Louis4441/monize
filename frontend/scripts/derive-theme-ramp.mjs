#!/usr/bin/env node
/**
 * Generate the gray ramp for each colour theme in src/app/themes.css.
 *
 * Why: the ramp is the theme. Cards, pages, borders and most text all read
 * from it, so it covers nearly every pixel -- while the accent ramp covers
 * buttons, links and chart series, which is a small fraction of the screen.
 * A theme whose ramp is near-neutral therefore looks like every other
 * near-neutral theme no matter how distinct its accent is, which is exactly
 * what the first pass at this got wrong: it tinted `--color-white` by one or
 * two percent and left the rest of the ramp grey.
 *
 * The measured evidence: gruvbox, the one palette that reliably read as its
 * own theme, carried a card chroma of 0.055; burgundy, forest, nord,
 * dracula and tokyonight sat between 0.003 and 0.007. This script puts every
 * theme at gruvbox's order of magnitude.
 *
 * How it works: lightness comes from one shared curve (below) and chroma
 * from one shared profile, so every theme separates page from card from
 * border by the same amount and only the HUE distinguishes them. That is
 * what keeps fifteen bolder palettes from becoming fifteen different
 * legibility problems -- contrast is a property of the curve, which is
 * checked once, rather than of each hand-picked value.
 *
 * Themes deliberately absent: `default` (stock Tailwind identity),
 * `midnight` (a neutral black AMOLED palette by design) and
 * `highcontrast`/`colorblind` (accessibility themes, where chroma spends
 * contrast and CVD budget for no benefit).
 *
 * Usage: node scripts/derive-theme-ramp.mjs
 * Output is literal 6-digit hex, which resolvePdfColor requires.
 */

/**
 * Lightness per ramp step, shared by every theme.
 *
 * One curve has to serve both modes, because light mode reads the 50-300 end
 * for surfaces and dark mode the 700-950 end:
 *   light: white = card, 50 = page, 200 = border, 500 = muted text, 900 = body
 *   dark:  800 = card, 900 = page, 700 = border, 400 = muted text, 100 = body
 * So `white` sits above `50` (card lifts off the page), and 700 > 800 > 900
 * (border lifts off the card, card lifts off the page) -- the dark-mode
 * separation that several themes previously lacked.
 */
const LIGHTNESS = {
  white: 0.950,
  50: 0.912,
  100: 0.875,
  200: 0.825,
  300: 0.755,
  400: 0.672,
  500: 0.520,
  600: 0.442,
  700: 0.394,
  800: 0.293,
  900: 0.222,
  950: 0.168,
};

/**
 * Chroma ceiling per ramp step, shared by every theme.
 *
 * This is a cap, not a target: the value actually used is the lesser of this
 * and a fixed share of what the hue can hold at that lightness (see
 * `chromaFor`). sRGB is drastically asymmetric near white -- at L 0.95 a
 * green can carry 0.10 chroma while a blue tops out near 0.024 -- so a flat
 * target tints the warm themes several times harder than the cool ones and
 * leaves exactly the palettes that looked interchangeable still looking
 * interchangeable. Taking a share of the available gamut instead spends each
 * hue's real headroom, and the cap stops the roomy hues going lurid.
 */
const CHROMA_CAP = {
  white: 0.046,
  50: 0.058,
  100: 0.064,
  200: 0.070,
  300: 0.072,
  400: 0.068,
  500: 0.062,
  600: 0.060,
  700: 0.058,
  800: 0.054,
  900: 0.048,
  950: 0.040,
};

/** Share of the hue's in-gamut chroma to spend at each step. */
const GAMUT_SHARE = 0.9;

/**
 * Per-theme hue, in OKLCH degrees.
 *
 * Several palettes deliberately shift hue between their light and dark ends
 * -- MS Money is parchment over navy, newspaper is salmon paper over slate --
 * so each theme names a light hue and a dark hue and the ramp interpolates
 * between them across the midtones. Where a theme is one hue throughout,
 * both are the same.
 */
const THEMES = {
  latte: { light: 84, dark: 66, note: 'warm cream paper over taupe darks' },
  msmoney: { light: 96, dark: 248, note: 'parchment paper over Money navy' },
  newspaper: { light: 52, dark: 268, note: 'salmon FT paper over navy slate' },
  burgundy: { light: 32, dark: 12, note: 'warm neutrals deepening into wine' },
  nord: { light: 248, dark: 254, note: 'arctic blue-grey throughout' },
  forest: { light: 132, dark: 146, note: 'green-tinted paper over forest darks' },
  solarized: { light: 92, dark: 205, note: 'base3 yellow over base03 cyan' },
  gruvbox: { light: 88, dark: 72, note: 'retro warm throughout' },
  dracula: { light: 300, dark: 292, note: 'violet throughout' },
  tokyonight: { light: 272, dark: 278, note: 'indigo throughout' },
  rosepine: { light: 18, dark: 296, note: 'dawn rose over main iris' },
};

const STEPS = ['white', 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/**
 * How far through the ramp a step sits, for interpolating the hue.
 *
 * The shift is deliberately concentrated in the 400-700 band rather than
 * spread evenly: a theme like MS Money is parchment *or* navy, and a ramp
 * that eases between them across every step spends half its range on
 * intermediate hues belonging to neither. Holding each end flat keeps the
 * surfaces on the hue the theme is actually named for.
 */
const HUE_POSITION = {
  white: 0,
  50: 0,
  100: 0,
  200: 0,
  300: 0.05,
  400: 0.15,
  500: 0.4,
  600: 0.7,
  700: 0.9,
  800: 1,
  900: 1,
  950: 1,
};

/**
 * Chroma damping through a wide hue shift.
 *
 * Interpolating between two distant hues passes through a third the theme
 * never chose -- parchment to navy crosses green. Damping chroma where the
 * crossing happens keeps those steps reading as neutral transitions instead
 * of as a colour nobody designed. A single-hue theme shifts by nothing and
 * is therefore undamped.
 */
function chromaDamp(hueDelta, t) {
  const span = Math.min(Math.abs(hueDelta), 180) / 180;
  return 1 - 0.45 * Math.sin(Math.PI * t) * span;
}

const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function oklchToRgb(L, C, hueDeg) {
  const H = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(linearToSrgb);
}

const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** The most chroma this hue can hold at this lightness in sRGB. */
function maxChroma(L, H) {
  let c = 0;
  while (c < 0.4 && inGamut(oklchToRgb(L, c + 0.002, H))) c += 0.002;
  return c;
}

/** The lesser of the step's cap and a fixed share of the available gamut. */
function chromaFor(step, L, H) {
  return Math.min(CHROMA_CAP[step], GAMUT_SHARE * maxChroma(L, H));
}

/** Back off chroma until the colour is representable in sRGB. */
function toHex(L, C, H) {
  let chroma = C;
  let rgb = oklchToRgb(L, chroma, H);
  while (!inGamut(rgb) && chroma > 0.001) {
    chroma -= 0.002;
    rgb = oklchToRgb(L, chroma, H);
  }
  return (
    '#' +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Shortest-path interpolation around the hue circle. */
function mixHue(a, b, t) {
  let delta = ((b - a + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
}

const lines = [];
for (const [name, cfg] of Object.entries(THEMES)) {
  lines.push(`/* ${name}: ${cfg.note} */`);
  for (const step of STEPS) {
    const t = HUE_POSITION[step];
    const hue = mixHue(cfg.light, cfg.dark, t);
    const delta = ((cfg.dark - cfg.light + 540) % 360) - 180;
    const base = chromaFor(step, LIGHTNESS[step], hue);
    const hex = toHex(LIGHTNESS[step], base * chromaDamp(delta, t), hue);
    const token = step === 'white' ? '--color-white' : `--color-gray-${step}`;
    lines.push(`  ${token}: ${hex};`);
  }
  // The dark-mode table stripe sits between the card (800) and page (900).
  const stripeL = (LIGHTNESS[800] + LIGHTNESS[900]) / 2;
  lines.push(
    `  --color-table-stripe-dark: ${toHex(stripeL, chromaFor(900, stripeL, cfg.dark), cfg.dark)};`,
  );
  lines.push('');
}

process.stdout.write(lines.join('\n'));
