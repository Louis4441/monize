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
 * Bars are drawn against 100%, so a 32% share fills a third of its track and the
 * empty remainder is part of the reading. They were briefly scaled against the
 * largest share instead, which drew the biggest sector full width whatever its
 * size -- a bar claiming everything beside a label saying 32% contradicts the
 * number it is supposed to restate, and that is worse than the sliver bars the
 * relative scaling was avoiding.
 *
 * Renders its empty state, not empty bars, when the data is absent. A security
 * with no sector data is not a security with zero-length bars.
 *
 * A long breakdown scrolls inside whatever height its parent gives it, rather
 * than growing the card or hiding rows behind a button. The card sits beside the
 * price chart and ends level with it, so its height cannot depend on whether a
 * fund reports three sectors or eleven -- nor on which tab is open. An expander
 * left a gap under the chart, and cutting the list needed a click to answer a
 * question the bars exist to answer at a glance. The scrollbar is
 * `scrollbar-slim`: the native one is a wide arrowed control drawn against the
 * figures, which is what made this look broken the first time round.
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

  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{emptyMessage}</p>
    );
  }

  return (
    // A column, so the list can take the leftover height and the remainder note
    // stays pinned under it.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Takes the height it is given and scrolls inside it, so the card is the
          same size for three sectors as for eleven. `pr-1` keeps the percentages
          off the thumb. */}
      <ul className="scrollbar-slim min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
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
                    // Against the whole, not against the largest slice. The
                    // floor is only so a rounding-error share still draws
                    // something; its number is printed beside it either way.
                    width: `${Math.max(row.weight * 100, 0.5)}%`,
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
    </div>
  );
}
