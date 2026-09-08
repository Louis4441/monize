'use client';

import { type KeyboardEvent, ReactNode } from 'react';
import { SortIcon } from './SortIcon';
import type { SortDirection } from '@/hooks/useSortableTable';

interface SortableHeaderProps<F extends string> {
  field: F;
  sortField: F;
  sortDirection: SortDirection;
  onSort: (field: F) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
  children: ReactNode;
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
}: SortableHeaderProps<F>) {
  const justify =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : '';
  const isActive = sortField === field;
  const sort = () => onSort(field);
  const handleKeyDown = (event: KeyboardEvent<HTMLTableCellElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    sort();
  };

  return (
    // `role="columnheader"` is the implicit role of a `<th>`, restated so it
    // survives a table restyled for phones (a `display` other than table-cell
    // drops the implicit role); inert everywhere else.
    <th
      role="columnheader"
      tabIndex={0}
      aria-sort={isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={sort}
      onKeyDown={handleKeyDown}
      className={`cursor-pointer transition-colors motion-reduce:transition-none hover:bg-gray-100 dark:hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400 select-none ${className}`}
    >
      <div className={`flex items-center ${justify}`}>
        {children}
        <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
      </div>
    </th>
  );
}
