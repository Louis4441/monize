'use client';

import { ReactNode } from 'react';
import { SortIcon } from './SortIcon';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from './interactive-row';
import type { SortDirection } from '@/hooks/useSortableTable';

interface SortableHeaderProps<F extends string> {
  field: F;
  sortField: F;
  sortDirection: SortDirection;
  onSort: (field: F) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
  children: ReactNode;
  /**
   * A control that lives in this header and does something other than sort --
   * the register's year toggle is the one. Activating it must not also sort
   * the column, so it renders inside a wrapper that stops the event before it
   * reaches the header. Moving the control out of the header instead would
   * separate it from the column it belongs to; leaving it in without the
   * wrapper makes every press on it sort as well.
   */
  controls?: ReactNode;
}

/**
 * Clickable column header with a sort indicator. Mirrors the style used by the
 * Accounts table so all reports sort consistently.
 */
export function SortableHeader<F extends string>({
  field,
  sortField,
  sortDirection,
  onSort,
  align = 'left',
  className = '',
  children,
  controls,
}: SortableHeaderProps<F>) {
  const justify =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : '';
  const isActive = sortField === field;
  const sort = () => onSort(field);

  return (
    // `role="columnheader"` is the implicit role of a `<th>`, restated so it
    // survives a table restyled for phones (a `display` other than table-cell
    // drops the implicit role); inert everywhere else.
    <th
      role="columnheader"
      tabIndex={0}
      aria-sort={isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={sort}
      onKeyDown={activateOnKey(sort)}
      className={`cursor-pointer transition-colors motion-reduce:transition-none hover:bg-gray-100 dark:hover:bg-gray-700 ${INTERACTIVE_ROW_FOCUS_CLASS} select-none ${className}`}
    >
      <div className={`flex items-center ${justify}`}>
        {children}
        <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
        {controls && (
          <span
            role="presentation"
            className="inline-flex items-center"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {controls}
          </span>
        )}
      </div>
    </th>
  );
}
