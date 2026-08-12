import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePriorCloseBaseline } from './usePriorCloseBaseline';
import { netWorthApi } from '@/lib/net-worth';

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

describe('usePriorCloseBaseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2026-08-04', value: 1000 },
    ]);
  });

  it('does not look one up for a range that measures from its first point', () => {
    const { result } = renderHook(() =>
      usePriorCloseBaseline({ range: '1y', firstPointDate: '2026-08-05' }),
    );
    expect(result.current).toBeNull();
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('does not look one up before the chart has any data', () => {
    const { result } = renderHook(() =>
      usePriorCloseBaseline({ range: '1w', firstPointDate: null }),
    );
    expect(result.current).toBeNull();
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('resolves the close before the first point', async () => {
    const { result } = renderHook(() =>
      usePriorCloseBaseline({ range: '1w', firstPointDate: '2026-08-05' }),
    );
    await waitFor(() =>
      expect(result.current).toMatchObject({ date: '2026-08-04', value: 1000 }),
    );
  });

  it('is unknown while a new selection is still loading', async () => {
    const first = deferred<Array<{ date: string; value: number }>>();
    vi.mocked(netWorthApi.getInvestmentsDaily).mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(
      (props: { firstPointDate: string }) =>
        usePriorCloseBaseline({ range: '1w', ...props }),
      { initialProps: { firstPointDate: '2026-08-05' } },
    );
    first.resolve([{ date: '2026-08-04', value: 1000 }]);
    await waitFor(() => expect(result.current?.value).toBe(1000));

    // A different chart is selected: the baseline that answered the previous
    // one must not stand in for it, even for a frame.
    const second = deferred<Array<{ date: string; value: number }>>();
    vi.mocked(netWorthApi.getInvestmentsDaily).mockReturnValueOnce(second.promise);
    rerender({ firstPointDate: '2026-08-11' });
    expect(result.current).toBeNull();

    second.resolve([{ date: '2026-08-10', value: 1200 }]);
    await waitFor(() =>
      expect(result.current).toMatchObject({ date: '2026-08-10', value: 1200 }),
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
        usePriorCloseBaseline({ range: '1w', ...props }),
      { initialProps: { firstPointDate: '2026-08-05' } },
    );
    rerender({ firstPointDate: '2026-08-11' });

    fast.resolve([{ date: '2026-08-10', value: 1200 }]);
    await waitFor(() => expect(result.current?.value).toBe(1200));

    // The first request lands last. Its answer belongs to a chart nobody is
    // looking at any more.
    slow.resolve([{ date: '2026-08-04', value: 1000 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toMatchObject({ date: '2026-08-10', value: 1200 });
  });

  it('reports a failed lookup as unknown', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockRejectedValue(
      new Error('boom'),
    );
    const { result } = renderHook(() =>
      usePriorCloseBaseline({ range: '1d', firstPointDate: '2026-08-12' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
  });

  it('refetches when the account filter changes', async () => {
    const { rerender } = renderHook(
      (props: { accountIds?: string }) =>
        usePriorCloseBaseline({
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
