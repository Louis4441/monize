import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistedAccountFilter } from './usePersistedAccountFilter';

const KEY = 'monize-reports-test-accounts';

describe('usePersistedAccountFilter', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts empty when nothing is stored', () => {
    const { result } = renderHook(() => usePersistedAccountFilter(KEY, []));
    expect(result.current[0]).toEqual([]);
  });

  it('restores a stored selection', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['acc-1']));
    const { result } = renderHook(() =>
      usePersistedAccountFilter(KEY, [{ id: 'acc-1' }, { id: 'acc-2' }]),
    );
    expect(result.current[0]).toEqual(['acc-1']);
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(['acc-1']));
  });

  it('persists a new selection', () => {
    const { result } = renderHook(() =>
      usePersistedAccountFilter(KEY, [{ id: 'acc-1' }]),
    );
    act(() => {
      result.current[1](['acc-1']);
    });
    expect(result.current[0]).toEqual(['acc-1']);
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(['acc-1']));
  });

  it('prunes stored IDs once the account list loads', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['acc-1', 'gone']));
    const { result, rerender } = renderHook(
      ({ accounts }) => usePersistedAccountFilter(KEY, accounts),
      { initialProps: { accounts: [] as Array<{ id: string }> } },
    );
    // Nothing to prune against before the accounts arrive.
    expect(result.current[0]).toEqual(['acc-1', 'gone']);

    rerender({ accounts: [{ id: 'acc-1' }] });
    expect(result.current[0]).toEqual(['acc-1']);
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(['acc-1']));
  });

  it('keeps the selection stable when the account list is rebuilt unchanged', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['acc-1']));
    const { result, rerender } = renderHook(
      ({ accounts }) => usePersistedAccountFilter(KEY, accounts),
      { initialProps: { accounts: [{ id: 'acc-1' }] } },
    );
    const first = result.current[0];
    // A fresh array with the same IDs (every report reload rebuilds one).
    rerender({ accounts: [{ id: 'acc-1' }] });
    expect(result.current[0]).toBe(first);
  });

  it('prunes via pruneAgainst for reports that load accounts later', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['acc-1', 'gone']));
    const { result, rerender } = renderHook(
      ({ accounts }) => {
        const filter = usePersistedAccountFilter(KEY);
        filter[2](accounts);
        return filter;
      },
      { initialProps: { accounts: [] as Array<{ id: string }> } },
    );
    expect(result.current[0]).toEqual(['acc-1', 'gone']);

    rerender({ accounts: [{ id: 'acc-1' }] });
    expect(result.current[0]).toEqual(['acc-1']);
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(['acc-1']));
  });

  it('ignores a stored value that is not an array', () => {
    window.localStorage.setItem(KEY, JSON.stringify('acc-1'));
    const { result } = renderHook(() =>
      usePersistedAccountFilter(KEY, [{ id: 'acc-1' }]),
    );
    expect(result.current[0]).toEqual([]);
  });
});
