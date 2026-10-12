import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@/test/render';
import toast from 'react-hot-toast';
import { useHiddenColumns } from './useHiddenColumns';

const { storeState } = vi.hoisted(() => ({
  storeState: {
    preferences: { hiddenTableColumns: {} as Record<string, string[]> },
  },
}));

const updatePreferencesApi = vi.fn();

vi.mock('@/store/preferencesStore', () => {
  const usePreferencesStore = ((selector: (s: unknown) => unknown) =>
    selector({ preferences: storeState.preferences })) as unknown as {
    (selector: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  usePreferencesStore.getState = () => ({
    preferences: storeState.preferences,
    updatePreferences: (patch: Record<string, unknown>) => {
      storeState.preferences = { ...storeState.preferences, ...patch } as typeof storeState.preferences;
    },
  });
  return { usePreferencesStore };
});

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => updatePreferencesApi(...args),
  },
}));

describe('useHiddenColumns', () => {
  beforeEach(() => {
    storeState.preferences = { hiddenTableColumns: {} };
    updatePreferencesApi.mockReset();
    (toast.error as ReturnType<typeof vi.fn>).mockReset?.();
  });

  it('reads the kind entry, dropping unknown ids', () => {
    storeState.preferences = {
      hiddenTableColumns: { transactions: ['tags', 'bogus'], investmentRegister: ['price'] },
    };
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    expect([...result.current.hidden]).toEqual(['tags']);
    expect(result.current.hideable).toEqual([
      'description',
      'refNumber',
      'tags',
      'attachments',
      'status',
    ]);
  });

  it('treats a missing map as nothing hidden', () => {
    storeState.preferences = {} as typeof storeState.preferences;
    const { result } = renderHook(() => useHiddenColumns('investmentHoldings'));
    expect(result.current.hidden.size).toBe(0);
    expect(result.current.isVisible('shares')).toBe(true);
  });

  it('isVisible is false for a hidden id and true for a structural one', () => {
    storeState.preferences = { hiddenTableColumns: { transactions: ['status'] } };
    const { result } = renderHook(() => useHiddenColumns('transactions'));
    expect(result.current.isVisible('status')).toBe(false);
    expect(result.current.isVisible('category')).toBe(true);
    expect(result.current.isVisible('amount')).toBe(true);
  });

  it('keeps isVisible stable across renders while the entry is unchanged', () => {
    storeState.preferences = { hiddenTableColumns: { transactions: ['status'] } };
    const { result, rerender } = renderHook(() => useHiddenColumns('transactions'));
    const first = result.current.isVisible;
    rerender();
    expect(result.current.isVisible).toBe(first);
  });

  it('updates optimistically and sends the whole map, canonicalised', async () => {
    storeState.preferences = {
      hiddenTableColumns: { transactions: ['status'], investmentRegister: ['price'] },
    };
    let resolveSave: (value: unknown) => void = () => {};
    updatePreferencesApi.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    const { result } = renderHook(() => useHiddenColumns('transactions'));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.hide('tags');
    });

    // Optimistic: the store already holds the new list before the save resolves.
    expect(storeState.preferences.hiddenTableColumns).toEqual({
      transactions: ['tags', 'status'],
      investmentRegister: ['price'],
    });
    expect(updatePreferencesApi).toHaveBeenCalledWith({
      hiddenTableColumns: {
        transactions: ['tags', 'status'],
        investmentRegister: ['price'],
      },
    });

    await act(async () => {
      resolveSave({
        hiddenTableColumns: {
          transactions: ['tags', 'status'],
          investmentRegister: ['price'],
        },
      });
      await pending;
    });
  });

  it('adopts the saved map from the response', async () => {
    const saved = { transactions: ['refNumber'], investmentHoldings: ['avgCost'] };
    updatePreferencesApi.mockResolvedValue({ hiddenTableColumns: saved });

    const { result } = renderHook(() => useHiddenColumns('transactions'));
    await act(async () => {
      await result.current.hide('refNumber');
    });

    expect(storeState.preferences.hiddenTableColumns).toEqual(saved);
  });

  it('does not duplicate an id hidden twice', async () => {
    storeState.preferences = { hiddenTableColumns: { investmentRegister: ['status'] } };
    updatePreferencesApi.mockImplementation(async (body: unknown) => body);

    const { result } = renderHook(() => useHiddenColumns('investmentRegister'));
    await act(async () => {
      await result.current.hide('status');
    });

    expect(updatePreferencesApi).toHaveBeenCalledWith({
      hiddenTableColumns: { investmentRegister: ['status'] },
    });
  });

  it('show removes one id and showAll empties the kind only', async () => {
    storeState.preferences = {
      hiddenTableColumns: {
        investmentHoldings: ['shares', 'price'],
        transactions: ['tags'],
      },
    };
    updatePreferencesApi.mockImplementation(async (body: unknown) => body);

    const { result } = renderHook(() => useHiddenColumns('investmentHoldings'));
    await act(async () => {
      await result.current.show('price');
    });
    expect(updatePreferencesApi).toHaveBeenLastCalledWith({
      hiddenTableColumns: { investmentHoldings: ['shares'], transactions: ['tags'] },
    });

    await act(async () => {
      await result.current.showAll();
    });
    expect(updatePreferencesApi).toHaveBeenLastCalledWith({
      hiddenTableColumns: { investmentHoldings: [], transactions: ['tags'] },
    });
  });

  it('reverts the optimistic update and toasts on failure', async () => {
    const before = { transactions: ['status'] };
    storeState.preferences = { hiddenTableColumns: before };
    updatePreferencesApi.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useHiddenColumns('transactions'));
    await act(async () => {
      await result.current.hide('tags');
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(storeState.preferences.hiddenTableColumns).toEqual(before);
  });
});
