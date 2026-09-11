'use client';

import { ReactNode } from 'react';

import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';

export interface ChartLegendItem {
  /** Stable React key. */
  key: string;
  /** The slice's name; a node so a surface can append a currency badge. */
  name: ReactNode;
  /** Swatch colour -- a chart token or a stored entity colour, as a CSS value. */
  color: string;
  /** Secondary line under the name (e.g. an amount and its share). */
  detail?: ReactNode;
  /** A figure shown at the row's trailing edge (e.g. a bare percentage). */
  trailing?: ReactNode;
  /** When set, the row is a button running this on click. */
  onClick?: () => void;
  /** Disables the button (kept a button so its label still reads). */
  disabled?: boolean;
}

interface ChartLegendProps {
  items: readonly ChartLegendItem[];
  /**
   * Column classes applied from `sm` up. A caller only says how the legend
   * widens on larger screens; the phone layout is `phoneColumns`. Default: two
   * from `sm`, three from `lg`.
   */
  columnsClassName?: string;
  /**
   * How many columns the legend has on a phone. One by default, which is what
   * a legend of long names needs. Pass `2` where the names are short enough to
   * read at half width -- a category legend of twenty rows is a long scroll in
   * one column -- and check the longest name at 320px: each row truncates
   * rather than wrapping, so an over-narrow column silently hides the end of a
   * name.
   */
  phoneColumns?: 1 | 2;
  className?: string;
}

const DEFAULT_COLUMNS = 'sm:grid-cols-2 lg:grid-cols-3';

/** The phone column count, as the class it compiles to. */
const PHONE_COLUMNS: Record<1 | 2, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
};

/**
 * The legend beside a categorical chart (a pie, a donut), rendered in one
 * vertical column on a phone by default and in compact multiple columns from
 * `sm` up.
 *
 * A three-column legend on a 320px screen wraps every name onto its own cramped
 * third-width; one column per row gives each name the whole width and reads
 * straight down beside the chart. A legend whose names are short can say
 * `phoneColumns={2}` and halve the scroll instead. From `sm` the caller's
 * `columnsClassName` restores the dense desktop grid.
 *
 * A row with an `onClick` is a button (with a `focus-visible` ring and a
 * `motion-reduce`-aware hover), so a legend that navigates stays keyboard
 * reachable; a disabled row stays a button so its name still reads. A row
 * without one is inert markup. Swatch colours arrive as CSS values and are
 * applied through `style` -- a stored category colour is not themable and must
 * not be forced onto the chart-token ramp.
 */
export function ChartLegend({
  items,
  columnsClassName = DEFAULT_COLUMNS,
  phoneColumns = 1,
  className,
}: ChartLegendProps) {
  return (
    <ul
      className={`grid ${PHONE_COLUMNS[phoneColumns]} gap-x-3 gap-y-1 ${columnsClassName} ${className ?? ''}`}
    >
      {items.map((item) => {
        const inner = (
          <>
            <span
              className="mt-1 h-3 w-3 flex-shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-gray-700 dark:text-gray-300">
                {item.name}
              </span>
              {item.detail != null && (
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {item.detail}
                </span>
              )}
            </span>
            {item.trailing != null && (
              <span className="ml-auto flex-shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                {item.trailing}
              </span>
            )}
          </>
        );

        return (
          <li key={item.key}>
            {item.onClick ? (
              <button
                type="button"
                onClick={item.onClick}
                disabled={item.disabled}
                className={`flex w-full items-start gap-2 rounded-md p-2 text-left text-sm ${HOVER_ROW_ON_CARD} disabled:hover:bg-transparent dark:disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 enabled:cursor-pointer disabled:cursor-default`}
              >
                {inner}
              </button>
            ) : (
              <div className="flex items-start gap-2 p-2 text-sm">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
