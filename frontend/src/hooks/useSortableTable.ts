'use client';

import { useCallback } from 'react';
import { useLocalStorage } from './useLocalStorage';

export type SortDirection = 'asc' | 'desc';

export interface SortState<F extends string> {
  field: F;
  direction: SortDirection;
}

/**
 * Hook for sortable table columns with localStorage persistence.
 *
 * Usage:
 *   const { sortField, sortDirection, handleSort } = useSortableTable<'name' | 'amount'>(
 *     'reports.spending-by-category.sort',
 *     { field: 'amount', direction: 'desc' },
 *   );
 *
 * Click the same column header again to toggle direction; clicking a different
 * column resets direction to 'asc'.
 */
export function useSortableTable<F extends string>(
  storageKey: string,
  defaultSort: SortState<F>,
): {
  sortField: F;
  sortDirection: SortDirection;
  handleSort: (field: F) => void;
  setSort: (sort: SortState<F>) => void;
} {
  const [sort, setSort] = useLocalStorage<SortState<F>>(storageKey, defaultSort);

  const handleSort = useCallback(
    (field: F) => {
      setSort((prev) =>
        prev.field === field
          ? { field, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
          : { field, direction: 'asc' },
      );
    },
    [setSort],
  );

  return {
    sortField: sort.field,
    sortDirection: sort.direction,
    handleSort,
    setSort,
  };
}

/**
 * Generic comparison helper that handles strings, numbers, dates (as ISO strings),
 * and null/undefined (sorted to the end regardless of direction).
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return String(a).localeCompare(String(b));
}
