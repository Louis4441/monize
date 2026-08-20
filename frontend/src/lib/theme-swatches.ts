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
    light: { page: '#f4dfb7', card: '#fdedcd', accent: '#8f5f29', chart2: '#68924f', chart4: '#c65d4a' },
    dark: { page: '#281603', card: '#3e260b', accent: '#c79350', chart2: '#81ae66', chart4: '#e77b66' },
  },
  msmoney: {
    light: { page: '#ede3b7', card: '#f7efcc', accent: '#2a653e', chart2: '#2c4a6e', chart4: '#a23b3b' },
    dark: { page: '#061c30', card: '#142e46', accent: '#71af82', chart2: '#80a1ca', chart4: '#e77975' },
  },
  newspaper: {
    light: { page: '#fbdac7', card: '#fdeadf', accent: '#990f3d', chart2: '#00824c', chart4: '#990f3d' },
    dark: { page: '#111a31', card: '#202b47', accent: '#f37c9e', chart2: '#4fb67c', chart4: '#eb7289' },
  },
  burgundy: {
    light: { page: '#fbd9d2', card: '#fdeae6', accent: '#93203c', chart2: '#2e7d4f', chart4: '#cd5a3e' },
    dark: { page: '#2e1015', card: '#432025', accent: '#ea7487', chart2: '#65b281', chart4: '#ec785b' },
  },
  nord: {
    light: { page: '#cee5fc', card: '#e4f0fd', accent: '#5e81ac', chart2: '#a3be8c', chart4: '#bf616a' },
    dark: { page: '#0a1c31', card: '#182d46', accent: '#88c0d0', chart2: '#a3be8c', chart4: '#d6757e' },
  },
  forest: {
    light: { page: '#d4ebc3', card: '#e3f6d6', accent: '#286e46', chart2: '#4f7d8c', chart4: '#b5543d' },
    dark: { page: '#0a210d', card: '#19331b', accent: '#64b284', chart2: '#78a7b7', chart4: '#e47e65' },
  },
  solarized: {
    light: { page: '#f0e2b7', card: '#f9eecc', accent: '#1e6fa8', chart2: '#859900', chart4: '#dc322f' },
    dark: { page: '#051f22', card: '#083237', accent: '#4ca3e1', chart2: '#859900', chart4: '#e83f39' },
  },
  gruvbox: {
    light: { page: '#f2e1b7', card: '#fbedcc', accent: '#af3a03', chart2: '#98971a', chart4: '#cc241d' },
    dark: { page: '#271703', card: '#3d2708', accent: '#e8802e', chart2: '#b8bb26', chart4: '#fb4934' },
  },
  dracula: {
    light: { page: '#e6dcfb', card: '#f1ebfc', accent: '#7e50ce', chart2: '#3ac463', chart4: '#ec4e4e' },
    dark: { page: '#1c162f', card: '#2d2745', accent: '#bd93f9', chart2: '#50fa7b', chart4: '#ff5555' },
  },
  tokyonight: {
    light: { page: '#d9e1fc', card: '#eaeefc', accent: '#2f55c4', chart2: '#74a857', chart4: '#f7768e' },
    dark: { page: '#161831', card: '#262947', accent: '#7aa2f7', chart2: '#9ece6a', chart4: '#f7768e' },
  },
  rosepine: {
    light: { page: '#fbd8d8', card: '#fde9e9', accent: '#286983', chart2: '#d7827e', chart4: '#b4637a' },
    dark: { page: '#1d162f', card: '#2f2644', accent: '#639ca6', chart2: '#ebbcba', chart4: '#eb6f92' },
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
