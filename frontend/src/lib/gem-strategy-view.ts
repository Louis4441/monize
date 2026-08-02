import { parseLocalDate } from '@/lib/utils';
import {
  GemAssetRef,
  GemAssetRole,
  GemHistoryEntry,
  GemPerformance,
  GemRange,
  GemWarning,
  GemWarningCode,
} from '@/types/gem-strategy';

/**
 * Presentation helpers for the GEM strategy report. Pure functions only -- the
 * strategy itself is evaluated server-side, so nothing here decides a signal;
 * these only order, colour and shape server data for rendering.
 */

/** Roles in the order the strategy lists them (equities first, defensive last). */
export const GEM_ROLE_ORDER: readonly GemAssetRole[] = [
  'US_EQUITY',
  'EX_US_EQUITY',
  'EM_EQUITY',
  'SAFE',
  'RISK_FREE',
] as const;

/**
 * Roles the strategy runs without. `RISK_FREE` is only the yardstick the
 * absolute test uses; leaving it unassigned falls back to the safe asset, so an
 * empty row is a choice rather than a gap to warn about.
 */
export const GEM_OPTIONAL_ROLES: readonly GemAssetRole[] = ['RISK_FREE'] as const;

/** Equity roles only -- the ones the relative-momentum step ranks. */
export const GEM_EQUITY_ROLES: readonly GemAssetRole[] = [
  'US_EQUITY',
  'EX_US_EQUITY',
  'EM_EQUITY',
] as const;

/**
 * One colour per role, shared by the chart, the legend, the assets card and the
 * history table so an asset keeps its identity across the page. Values are
 * `var(--chart-*)` references (see `lib/chart-colors.ts`): blue for the US
 * equity leg, green for developed ex-US, purple for emerging markets (the GEM
 * accent), amber for the safe asset, teal for the risk-free yardstick.
 */
export const GEM_ROLE_COLOURS: Record<GemAssetRole, string> = {
  US_EQUITY: 'var(--chart-1)',
  EX_US_EQUITY: 'var(--chart-2)',
  EM_EQUITY: 'var(--chart-5)',
  SAFE: 'var(--chart-3)',
  RISK_FREE: 'var(--chart-4)',
};

/** Selectable chart windows, shortest first. `1Y` is the default. */
export const GEM_RANGES: readonly GemRange[] = ['3M', '6M', '1Y', '3Y', '5Y', 'MAX'] as const;

export const GEM_DEFAULT_RANGE: GemRange = '1Y';

/** True when a server value is a usable number (not null/undefined/NaN). */
export function isKnown(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True when a role has an instrument assigned. */
export function isMapped(asset: GemAssetRef | null | undefined): boolean {
  return !!asset && !!asset.symbol;
}

/**
 * Label for an instrument: "SPY" when only the ticker is known, "SPY -- name"
 * is left to the caller (the cards show them on separate lines). Returns null
 * when the role has no instrument so callers can render an unknown marker
 * instead of an empty string.
 */
export function assetSymbol(asset: GemAssetRef | null | undefined): string | null {
  return asset?.symbol ?? null;
}

/** One merged chart row: a timestamp plus each role's cumulative return. */
export interface GemPerformanceRow {
  ts: number;
  [role: string]: number | null;
}

/**
 * Recharts rows for the performance chart: one row per observation date, x-axis
 * keyed on a timestamp (matching the securities comparison chart, so the time
 * axis stays evenly spaced however densely prices are sampled). Missing
 * observations stay `null` so Recharts leaves a gap in the line rather than
 * drawing through a value that does not exist.
 */
export function buildPerformanceRows(
  performance: GemPerformance | null,
): GemPerformanceRow[] {
  if (!performance) return [];
  // The simulated line rides on the same rows, keyed apart from the roles so
  // it can never be mistaken for one: it is a portfolio, not an asset.
  const simulated = new Map(
    (performance.currentPortfolio?.points ?? []).map((point) => [
      point.date,
      point.returnPercent,
    ]),
  );
  return performance.points
    .map((point) => {
      const row: GemPerformanceRow = { ts: parseLocalDate(point.date).getTime() };
      for (const role of GEM_ROLE_ORDER) {
        const value = point.values[role];
        row[role] = isKnown(value) ? value : null;
      }
      const portfolio = simulated.get(point.date);
      row[GEM_PORTFOLIO_SERIES] = isKnown(portfolio) ? portfolio : null;
      return row;
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Series key for the simulated current composition. Deliberately not a
 * `GemAssetRole`: it is a hypothetical portfolio, and a role would put it in
 * every place the code iterates the strategy's assets.
 */
export const GEM_PORTFOLIO_SERIES = 'CURRENT_PORTFOLIO';

/**
 * Index of the last row carrying a value for `role`, or -1 when the role has no
 * data. Used to place the end-of-line percentage label on the point where the
 * line actually stops.
 */
export function lastKnownIndex(rows: GemPerformanceRow[], role: GemAssetRole): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (isKnown(rows[i][role])) return i;
  }
  return -1;
}

/** Roles that actually carry at least one observation in the range. */
export function rolesWithData(performance: GemPerformance | null): GemAssetRole[] {
  if (!performance) return [];
  return GEM_ROLE_ORDER.filter((role) =>
    performance.points.some((point) => isKnown(point.values[role])),
  );
}

/**
 * Y-axis domain padded by 5% of the series span so the end-of-line labels and
 * the zero line stay inside the plot area. Returns `undefined` (Recharts
 * auto-domain) when there is nothing to measure.
 */
export function performanceDomain(
  performance: GemPerformance | null,
): [number, number] | undefined {
  if (!performance) return undefined;
  const values = [
    ...performance.points.flatMap((point) =>
      GEM_ROLE_ORDER.map((role) => point.values[role]).filter(isKnown),
    ),
    // The simulated line has to fit inside the plot too.
    ...(performance.currentPortfolio?.points ?? [])
      .map((point) => point.returnPercent)
      .filter(isKnown),
  ];
  if (values.length === 0) return undefined;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const pad = Math.max((max - min) * 0.05, 1);
  return [Math.floor(min - pad), Math.ceil(max + pad)];
}

/**
 * Bar width (0-100) for a momentum comparison bar. Momentum can be negative, so
 * bars are scaled against the largest absolute value in the compared set and
 * always keep a 2% sliver so a near-zero result is still visible.
 */
export function momentumBarWidth(
  value: number | null,
  values: Array<number | null>,
): number {
  if (!isKnown(value)) return 0;
  const scale = Math.max(...values.filter(isKnown).map((v) => Math.abs(v)), 1);
  return Math.max(Math.min((Math.abs(value) / scale) * 100, 100), 2);
}

/** Clamp a server compliance percentage into the 0-100 the progress bar draws. */
export function compliancePercent(value: number | null): number | null {
  if (!isKnown(value)) return null;
  return Math.min(Math.max(value, 0), 100);
}

/** Warning codes present in the report, as a set for cheap lookups. */
export function warningCodes(warnings: GemWarning[] | undefined): Set<GemWarningCode> {
  return new Set((warnings ?? []).map((warning) => warning.code));
}

/** Roles flagged by the given warning code (e.g. every role missing an ETF). */
export function warnedRoles(
  warnings: GemWarning[] | undefined,
  code: GemWarningCode,
): GemAssetRole[] {
  const roles = (warnings ?? [])
    .filter((warning) => warning.code === code)
    .flatMap((warning) => warning.roles ?? []);
  return GEM_ROLE_ORDER.filter((role) => roles.includes(role));
}

/** History newest-first, without mutating the server array. */
export function sortHistoryNewestFirst(history: GemHistoryEntry[]): GemHistoryEntry[] {
  return [...history].sort((a, b) => b.evaluatedOn.localeCompare(a.evaluatedOn));
}
