import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import {
  SURFACE_LAYERS,
  VIEW_MODE_STORAGE_KEY,
  useViewMode,
  useViewModeStore,
} from './viewModeStore';

function resetStore() {
  window.localStorage.clear();
  useViewModeStore.setState({
    surfaces: {
      transactions: { view: 'table', layers: ['transactions'] },
      investments: { view: 'table', layers: ['transactions'] },
    },
  });
}

describe('viewModeStore', () => {
  beforeEach(resetStore);

  it('starts every surface on the table, so nothing changes until the reader asks', () => {
    const { result } = renderHook(() => useViewMode('transactions'));
    expect(result.current.view).toBe('table');
    expect(result.current.layers).toEqual(['transactions']);
  });

  it('remembers each surface separately', () => {
    const { result } = renderHook(() => useViewMode('transactions'));
    act(() => result.current.setView('calendar'));

    expect(useViewModeStore.getState().surfaces.transactions.view).toBe('calendar');
    expect(useViewModeStore.getState().surfaces.investments.view).toBe('table');
  });

  it('switches a layer on and off', () => {
    const { result } = renderHook(() => useViewMode('transactions'));

    act(() => result.current.toggleLayer('balances'));
    expect(result.current.layers).toEqual(['transactions', 'balances']);
    expect(result.current.isLayerOn('balances')).toBe(true);

    act(() => result.current.toggleLayer('transactions'));
    expect(result.current.layers).toEqual(['balances']);
  });

  it('keeps the layers in the toolbar order whatever order they were switched on', () => {
    const { result } = renderHook(() => useViewMode('investments'));

    act(() => result.current.toggleLayer('dailyChange'));
    act(() => result.current.toggleLayer('values'));

    expect(result.current.layers).toEqual(['transactions', 'values', 'dailyChange']);
  });

  it('refuses to switch off the last layer', () => {
    // A calendar with every layer off is a month of empty boxes, which reads as
    // a page that failed rather than as a choice.
    const { result } = renderHook(() => useViewMode('transactions'));

    act(() => result.current.toggleLayer('transactions'));

    expect(result.current.layers).toEqual(['transactions']);
  });

  it('offers each surface only its own layers', () => {
    expect(SURFACE_LAYERS.transactions).not.toContain('dailyChange');
    expect(SURFACE_LAYERS.investments).not.toContain('balances');
  });
});

describe('viewModeStore rehydration', () => {
  beforeEach(resetStore);

  async function rehydrate(stored: unknown) {
    window.localStorage.setItem(
      VIEW_MODE_STORAGE_KEY,
      JSON.stringify({ state: { surfaces: stored }, version: 0 }),
    );
    await act(async () => {
      await useViewModeStore.persist.rehydrate();
    });
    return useViewModeStore.getState().surfaces;
  }

  it('restores a stored choice', async () => {
    const surfaces = await rehydrate({
      transactions: { view: 'calendar', layers: ['balances'] },
      investments: { view: 'table', layers: ['transactions'] },
    });

    expect(surfaces.transactions).toEqual({ view: 'calendar', layers: ['balances'] });
  });

  it('discards a view it does not recognise', async () => {
    const surfaces = await rehydrate({ transactions: { view: 'agenda', layers: ['balances'] } });
    expect(surfaces.transactions.view).toBe('table');
  });

  it('drops a layer belonging to the other surface', async () => {
    const surfaces = await rehydrate({
      transactions: { view: 'calendar', layers: ['balances', 'dailyChange'] },
    });
    expect(surfaces.transactions.layers).toEqual(['balances']);
  });

  it('falls back to the default layer when the stored list leaves none', async () => {
    const surfaces = await rehydrate({ transactions: { view: 'calendar', layers: [] } });
    expect(surfaces.transactions.layers).toEqual(['transactions']);
  });

  it.each([null, 'calendar', 42, { transactions: 'calendar' }])(
    'survives junk in storage (%s)',
    async (stored) => {
      const surfaces = await rehydrate(stored);
      expect(surfaces.transactions).toEqual({ view: 'table', layers: ['transactions'] });
      expect(surfaces.investments).toEqual({ view: 'table', layers: ['transactions'] });
    },
  );

  it('persists only the choices, never the actions', () => {
    const partialize = useViewModeStore.persist.getOptions().partialize!;
    const persisted = partialize(useViewModeStore.getState()) as Record<string, unknown>;
    expect(Object.keys(persisted)).toEqual(['surfaces']);
  });
});
