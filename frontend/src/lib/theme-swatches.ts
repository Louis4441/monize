import { ColorTheme } from '@/lib/color-themes';

/**
 * The handful of colours that identify a theme at a glance, for the picker in
 * Settings -> Preferences.
 *
 * Why this is a TypeScript map rather than something read off the running
 * page: a palette is defined under `html[data-theme='x']`, so the browser
 * only ever computes the *active* theme's variables. Drawing fifteen previews
 * means holding the values here.
 *
 * That duplication is the risk, so `theme-swatches.test.ts` parses
 * `themes.css`/`globals.css` and fails when any swatch disagrees with the
 * token it claims to show. Edit a palette and the guard tells you which
 * swatch went stale; never edit one of these by itself.
 */
export interface ThemeSwatch {
  /** --color-gray-50 (light) / --color-gray-900 (dark): the page behind cards. */
  page: string;
  /** --color-white (light) / --color-gray-800 (dark): the dominant surface. */
  card: string;
  /** --color-blue-600 (light) / --color-blue-400 (dark): buttons and links. */
  accent: string;
  /** Two chart series, the part of a palette a dashboard actually shows. */
  chart2: string;
  chart4: string;
}

export const THEME_SWATCHES: Record<ColorTheme, { light: ThemeSwatch; dark: ThemeSwatch }> = {
  default: {
    light: { page: '#f9fafb', card: '#ffffff', accent: '#155dfc', chart2: '#10b981', chart4: '#ef4444' },
    dark: { page: '#101828', card: '#1e2939', accent: '#51a2ff', chart2: '#34d399', chart4: '#f87171' },
  },
  latte: {
    light: { page: '#f6f1e7', card: '#fbf7ef', accent: '#8f5f29', chart2: '#6f9b54', chart4: '#c65d4a' },
    dark: { page: '#241f19', card: '#352d24', accent: '#c79350', chart2: '#81ae66', chart4: '#e77b66' },
  },
  msmoney: {
    light: { page: '#f5f0dd', card: '#fdfaf1', accent: '#2a653e', chart2: '#2c4a6e', chart4: '#a23b3b' },
    dark: { page: '#132230', card: '#243646', accent: '#71af82', chart2: '#80a1ca', chart4: '#e77975' },
  },
  newspaper: {
    light: { page: '#fff1e5', card: '#fff8f0', accent: '#990f3d', chart2: '#00824c', chart4: '#990f3d' },
    dark: { page: '#262a33', card: '#33363f', accent: '#f37c9e', chart2: '#4fb67c', chart4: '#eb7289' },
  },
  burgundy: {
    light: { page: '#faf9f8', card: '#fbf8f7', accent: '#93203c', chart2: '#2e7d4f', chart4: '#cd5a3e' },
    dark: { page: '#201d1b', card: '#2e2a28', accent: '#ea7487', chart2: '#65b281', chart4: '#ec785b' },
  },
  nord: {
    light: { page: '#eceff4', card: '#f9fafc', accent: '#5e81ac', chart2: '#a3be8c', chart4: '#bf616a' },
    dark: { page: '#272c36', card: '#3b4252', accent: '#88c0d0', chart2: '#a3be8c', chart4: '#d6757e' },
  },
  forest: {
    light: { page: '#fafaf9', card: '#fbfaf7', accent: '#286e46', chart2: '#4f7d8c', chart4: '#b5543d' },
    dark: { page: '#1c1917', card: '#292524', accent: '#64b284', chart2: '#78a7b7', chart4: '#e47e65' },
  },
  solarized: {
    light: { page: '#eee8d5', card: '#fdf6e3', accent: '#1f74b0', chart2: '#859900', chart4: '#dc322f' },
    dark: { page: '#002b36', card: '#073642', accent: '#4ca3e1', chart2: '#859900', chart4: '#e83f39' },
  },
  gruvbox: {
    light: { page: '#f4e8be', card: '#fbf1c7', accent: '#af3a03', chart2: '#98971a', chart4: '#cc241d' },
    dark: { page: '#1d2021', card: '#32302f', accent: '#e8802e', chart2: '#b8bb26', chart4: '#fb4934' },
  },
  dracula: {
    light: { page: '#f7f7fb', card: '#fbfaff', accent: '#8454d8', chart2: '#3ac463', chart4: '#ff5555' },
    dark: { page: '#21222c', card: '#2b2d3d', accent: '#bd93f9', chart2: '#50fa7b', chart4: '#ff5555' },
  },
  tokyonight: {
    light: { page: '#eceef4', card: '#f9fafd', accent: '#2f55c4', chart2: '#74a857', chart4: '#f7768e' },
    dark: { page: '#1a1b26', card: '#24283b', accent: '#7aa2f7', chart2: '#9ece6a', chart4: '#f7768e' },
  },
  rosepine: {
    light: { page: '#faf4ed', card: '#fffaf3', accent: '#286983', chart2: '#d7827e', chart4: '#b4637a' },
    dark: { page: '#191724', card: '#1f1d2e', accent: '#56949f', chart2: '#ebbcba', chart4: '#eb6f92' },
  },
  midnight: {
    light: { page: '#fafafa', card: '#ffffff', accent: '#155dfc', chart2: '#10b981', chart4: '#ef4444' },
    dark: { page: '#000000', card: '#0c0c0c', accent: '#51a2ff', chart2: '#34d399', chart4: '#f87171' },
  },
  highcontrast: {
    light: { page: '#ffffff', card: '#ffffff', accent: '#1a3faf', chart2: '#15803d', chart4: '#b91c1c' },
    dark: { page: '#000000', card: '#0a0a0a', accent: '#93c5fd', chart2: '#4ade80', chart4: '#f87171' },
  },
  colorblind: {
    light: { page: '#f9fafb', card: '#ffffff', accent: '#005e94', chart2: '#009e73', chart4: '#d55e00' },
    dark: { page: '#101828', card: '#1e2939', accent: '#4299d3', chart2: '#009e73', chart4: '#d55e00' },
  },
};
