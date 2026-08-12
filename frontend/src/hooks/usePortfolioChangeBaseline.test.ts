import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePortfolioChangeBaseline } from './usePortfolioChangeBaseline';
import { usePreferencesStore } from '@/store/preferencesStore';
import { netWorthApi } from '@/lib/net-worth';
import type { UserPreferences } from '@/types/auth';
import type { PortfolioChangeBaseline } from '@/types/investment';

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsDaily: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

/** A promise a test resolves when it chooses, for out-of-order responses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Put the stored preference in whichever of its three states a test needs. */
function setPreference(value: PortfolioChangeBaseline | undefined) {
  usePreferencesStore.setState({
    preferences:
      value === undefined
        ? null
        : ({ portfolioChangeBaseline: value } as UserPreferences),
  });
}

describe('usePortfolioChangeBaseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPreference('previous_close');
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2026-08-04', value: 1000 },
    ]);
  });

  it('does not look one up for a range that measures from its first point', () => {
    const { result } = renderHook(() =>
      usePortfolioChangeBaseline({ range: '1y', firstPointDate: '2026-08-05' }),
    );
    expect(result.current.usesPriorClose).toBe(false);
    expect(result.current.priorClose).toBeNull();
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('does not look one up before the chart has any data', () => {
    const { result } = renderHook(() =>
      usePortfolioChangeBaseline({ range: '1w', firstPointDate: null }),
    );
    expect(result.current.priorClose).toBeNull();
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('resolves the close before the first point', async () => {
    const { result } = renderHook(() =>
      usePortfolioChangeBaseline({ range: '1w', firstPointDate: '2026-08-05' }),
    );
    expect(result.current.usesPriorClose).toBe(true);
    await waitFor(() =>
      expect(result.current.priorClose).toMatchObject({
        date: '2026-08-04',
        value: 1000,
      }),
    );
  });

  describe('the stored preference', () => {
    it('turns the lookup off entirely when set to the period start', () => {
      setPreference('period_start');
      const { result } = renderHook(() =>
        usePortfolioChangeBaseline({ range: '1w', firstPointDate: '2026-08-05' }),
      );
      expect(result.current.usesPriorClose).toBe(false);
      expect(result.current.priorClose).toBeNull();
      // No preference, no request: the chart measures from its own first point.
      expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
    });

    it('falls back to the prior close while preferences have not loaded', async () => {
      // The default matches the column default, so the figure on screen does
      // not flip the moment the preferences arrive.
      setPreference(undefined);
      const { result } = renderHook(() =>
        usePortfolioChangeBaseline({ range: '1w', firstPointDate: '2026-08-05' }),
      );
      expect(result.current.usesPriorClose).toBe(true);
      await waitFor(() => expect(result.current.priorClose?.value).toBe(1000));
    });

    it('drops a loaded baseline when the preference switches away from it', async () => {
      const { result, rerender } = renderHook(() =>
        usePortfolioChangeBaseline({ range: '1w', firstPointDate: '2026-08-05' }),
      );
      await waitFor(() => expect(result.current.priorClose?.value).toBe(1000));

      setPreference('period_start');
      rerender();
      // Both halves move together -- a stale prior close must not stay on
      // screen under a setting that says to measure from somewhere else.
      expect(result.current.usesPriorClose).toBe(false);
      expect(result.current.priorClose).toBeNull();
    });
  });

  it('is unknown while a new selection is still loading', async () => {
    const first = deferred<Array<{ date: string; value: number }>>();
    vi.mocked(netWorthApi.getInvestmentsDaily).mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(
      (props: { firstPointDate: string }) =>
        usePortfolioChangeBaseline({ range: '1w', ...props }),
      { initialProps: { firstPointDate: '2026-08-05' } },
    );
    first.resolve([{ date: '2026-08-04', value: 1000 }]);
    await waitFor(() => expect(result.current.priorClose?.value).toBe(1000));

    // A different chart is selected: the baseline that answered the previous
    // one must not stand in for it, even for a frame.
    const second = deferred<Array<{ date: string; value: number }>>();
    vi.mocked(netWorthApi.getInvestmentsDaily).mockReturnValueOnce(second.promise);
    rerender({ firstPointDate: '2026-08-11' });
    expect(result.current.priorClose).toBeNull();

    second.resolve([{ date: '2026-08-10', value: 1200 }]);
    await waitFor(() =>
      expect(result.current.priorClose).toMatchObject({
        date: '2026-08-10',
        value: 1200,
      }),
    );
  });

  it('discards a response that arrives after the selection moved on', async () => {
    const slow = deferred<Array<{ date: string; value: number }>>();
    const fast = deferred<Array<{ date: string; value: number }>>();
    vi.mocked(netWorthApi.getInvestmentsDaily)
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);

    const { result, rerender } = renderHook(
      (props: { firstPointDate: string }) =>
        usePortfolioChangeBaseline({ range: '1w', ...props }),
      { initialProps: { firstPointDate: '2026-08-05' } },
    );
    rerender({ firstPointDate: '2026-08-11' });

    fast.resolve([{ date: '2026-08-10', value: 1200 }]);
    await waitFor(() => expect(result.current.priorClose?.value).toBe(1200));

    // The first request lands last. Its answer belongs to a chart nobody is
    // looking at any more.
    slow.resolve([{ date: '2026-08-04', value: 1000 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.priorClose).toMatchObject({
      date: '2026-08-10',
      value: 1200,
    });
  });

  it('reports a failed lookup as unknown', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockRejectedValue(
      new Error('boom'),
    );
    const { result } = renderHook(() =>
      usePortfolioChangeBaseline({ range: '1d', firstPointDate: '2026-08-12' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // Still the prior-close mode -- the setting has not changed, the number is
    // simply not known.
    expect(result.current.usesPriorClose).toBe(true);
    expect(result.current.priorClose).toBeNull();
  });

  it('refetches when the account filter changes', async () => {
    const { rerender } = renderHook(
      (props: { accountIds?: string }) =>
        usePortfolioChangeBaseline({
          range: '1w',
          firstPointDate: '2026-08-05',
          ...props,
        }),
      { initialProps: { accountIds: 'a' } },
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1),
    );
    rerender({ accountIds: 'b' });
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(2),
    );
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountIds: 'b' }),
    );
  });
});
