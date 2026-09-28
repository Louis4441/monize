'use client';

import { useMemo } from 'react';
import { applyPortfolioWindowStart } from '@/components/investments/portfolio-range-window';

/**
 * The window a Portfolio Value chart requests: the base window with the
 * per-range portfolio rule applied (`portfolio-range-window.ts`).
 *
 * One hook for the Portfolio Value report, the Investments chart and the
 * dashboard widget, so the three cannot disagree about where a range opens.
 */
export function usePortfolioRangeWindow(params: {
  range: string;
  /** The window as `useDateRange`/`resolveRangePreset` resolved it. */
  base: { start: string; end: string };
  /** Injectable "now", for deterministic tests. */
  now?: Date;
}): { start: string; end: string } {
  const { range, base, now } = params;
  return useMemo(
    () => applyPortfolioWindowStart(range, base, { now }),
    [range, base, now],
  );
}
