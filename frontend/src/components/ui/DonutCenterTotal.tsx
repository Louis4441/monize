'use client';

import { ReactNode } from 'react';

interface DonutCenterTotalProps {
  /** Caption above the figure, e.g. "Total". */
  label: ReactNode;
  /**
   * The aggregate figure to show in the hole. Already localized by the caller
   * (through `useNumberFormat`), so this component never formats a number
   * itself -- it only positions one.
   */
  value: ReactNode;
  className?: string;
}

/**
 * The total that belongs in a donut's empty centre, absolutely positioned over
 * the chart so the hole stops being wasted space on a phone.
 *
 * It is an OVERLAY, not part of the chart: the caller makes the chart's own box
 * `relative` and drops this beside the `ResponsiveContainer`. The container is
 * `pointer-events-none` so a hover still reaches the slices beneath it, while
 * the figure itself re-enables pointer events so a `PartialTotal` marker inside
 * `value` stays hoverable.
 *
 * The figure is passed already formatted -- this file names no formatter and no
 * separator, which is what keeps it out of the number-locale guard: a number a
 * person reads is localized by the caller's `useNumberFormat`, here as
 * everywhere.
 */
export function DonutCenterTotal({ label, value, className }: DonutCenterTotalProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center ${className ?? ''}`}
    >
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      <span className="pointer-events-auto mt-0.5 max-w-full truncate text-base font-semibold text-gray-900 dark:text-gray-100 sm:text-lg">
        {value}
      </span>
    </div>
  );
}
