import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSortableTable, compareValues } from './useSortableTable';

describe('useSortableTable', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns the default sort when localStorage is empty', () => {
    const { result } = renderHook(() =>
      useSortableTable<'name' | 'amount'>('test.key', { field: 'amount', direction: 'desc' }),
    );
    expect(result.current.sortField).toBe('amount');
    expect(result.current.sortDirection).toBe('desc');
  });

  it('reads persisted sort from localStorage', () => {
    window.localStorage.setItem(
      'test.key',
      JSON.stringify({ field: 'name', direction: 'asc' }),
    );
    const { result } = renderHook(() =>
      useSortableTable<'name' | 'amount'>('test.key', { field: 'amount', direction: 'desc' }),
    );
    expect(result.current.sortField).toBe('name');
    expect(result.current.sortDirection).toBe('asc');
  });

  it('toggles direction when clicking the same field', () => {
    const { result } = renderHook(() =>
      useSortableTable<'name' | 'amount'>('test.key', { field: 'name', direction: 'asc' }),
    );
    act(() => result.current.handleSort('name'));
    expect(result.current.sortDirection).toBe('desc');
    act(() => result.current.handleSort('name'));
    expect(result.current.sortDirection).toBe('asc');
  });

  it('switches field and resets direction to asc on a new column', () => {
    const { result } = renderHook(() =>
      useSortableTable<'name' | 'amount'>('test.key', { field: 'name', direction: 'desc' }),
    );
    act(() => result.current.handleSort('amount'));
    expect(result.current.sortField).toBe('amount');
    expect(result.current.sortDirection).toBe('asc');
  });

  it('persists changes to localStorage', () => {
    const { result } = renderHook(() =>
      useSortableTable<'name' | 'amount'>('test.key', { field: 'name', direction: 'asc' }),
    );
    act(() => result.current.handleSort('amount'));
    expect(JSON.parse(window.localStorage.getItem('test.key')!)).toEqual({
      field: 'amount',
      direction: 'asc',
    });
  });
});

describe('compareValues', () => {
  it('compares numbers numerically', () => {
    expect(compareValues(3, 10)).toBeLessThan(0);
    expect(compareValues(10, 3)).toBeGreaterThan(0);
    expect(compareValues(5, 5)).toBe(0);
  });

  it('compares strings via locale compare', () => {
    expect(compareValues('a', 'b')).toBeLessThan(0);
    expect(compareValues('B', 'a')).toBeGreaterThan(0);
  });

  it('sorts null and undefined to the end', () => {
    expect(compareValues(null, 5)).toBeGreaterThan(0);
    expect(compareValues(5, null)).toBeLessThan(0);
    expect(compareValues(undefined, undefined)).toBe(0);
  });
});
