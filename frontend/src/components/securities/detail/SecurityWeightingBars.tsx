'use client';

import { useMemo } from 'react';
import { chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';

/** One slice of a breakdown: a name and its share as a decimal 0-1. */
export interface WeightingSlice {
  name: string;
  weight: number;
}

interface SecurityWeightingBarsProps {
  slices: readonly WeightingSlice[] | null | undefined;
  /** Shown in place of the bars when there is nothing stored. */
  emptyMessage: string;
  /** Caption under the bars when the shares do not add up to 100%. */
  remainderLabel?: (percent: string) => string;
}

/**
 * A breakdown of one security across a dimension -- sectors, countries, and
 * (once the field exists) asset classes.
 *
 * Horizontal bars, sorted largest first, in a single hue. This is one series
 * answering "how big is each share", not eleven categories needing eleven
 * colours: a pie of eleven sectors needs a legend to be read at all, and
 * colour-coding rows whose names are already printed beside them adds nothing
 * but a colourblindness problem. Each share is labelled directly, so the bar is
 * a second reading of the number rather than the only one.
 *
 * Renders its empty state, not empty bars, when the data is absent. A security
 * with no sector data is not a security with zero-length bars.
 */
export function SecurityWeightingBars({
  slices,
  emptyMessage,
  remainderLabel,
}: SecurityWeightingBarsProps) {
  const { formatPercent } = useNumberFormat();

  const rows = useMemo(() => {
    const usable = (slices ?? []).filter(
      (slice) => !!slice.name && isFinite(slice.weight) && slice.weight > 0,
    );
    // Largest first: the question this answers is "what is it mostly".
    return [...usable].sort((a, b) => b.weight - a.weight);
  }, [slices]);

  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  // Providers report the classified part only, so a fund can add up to less than
  // 100%. Saying so beats letting the reader assume the rest is missing data.
  const remainder = 1 - total;
  const showRemainder =
    !!remainderLabel && rows.length > 0 && remainder > 0.005;

  // Bars are scaled against the largest share, not against 100%: a fund whose
  // biggest sector is 22% would otherwise draw every bar as a sliver.
  const scale = rows.length > 0 ? rows[0].weight : 1;

  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{emptyMessage}</p>
    );
  }

  return (
    <>
      {/* Capped and scrollable: a fund with eleven sectors must not push this
          card past the bottom of the chart it sits beside. */}
      <ul className="max-h-44 space-y-2 overflow-y-auto pr-1">
        {rows.map((row) => {
          const percent = formatPercent(row.weight * 100);
          return (
            <li key={row.name}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-gray-700 dark:text-gray-300">
                  {row.name}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100">
                  {percent}
                </span>
              </div>
              {/* The track is recessive; the fill carries the one hue. Rounded
                  ends, thin mark, anchored to the left baseline. */}
              <div
                className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
                role="img"
                aria-label={`${row.name}: ${percent}`}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max((row.weight / scale) * 100, 2)}%`,
                    backgroundColor: chartColors.primary,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {showRemainder && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {remainderLabel(formatPercent(remainder * 100))}
        </p>
      )}
    </>
  );
}
