import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useReportData } from './useReportData';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

describe('useReportData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts in a loading state with no data or error', () => {
    const fetcher = vi.fn(() => new Promise<number>(() => {}));
    const { result } = renderHook(() => useReportData(fetcher, []));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('loads data and clears loading on success', async () => {
    const fetcher = vi.fn(async () => ({ value: 42 }));
    const { result } = renderHook(() => useReportData(fetcher, []));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces an Error on failure and stops loading', async () => {
    const err = new Error('boom');
    const fetcher = vi.fn(async () => {
      throw err;
    });
    const { result } = renderHook(() => useReportData(fetcher, []));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.data).toBeNull();
  });

  it('wraps non-Error rejections in an Error', async () => {
    const fetcher = vi.fn(async () => {
      throw 'string failure';
    });
    const { result } = renderHook(() => useReportData(fetcher, []));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('string failure');
  });

  it('re-runs when deps change', async () => {
    const fetcher = vi.fn(async (n: number) => n * 2);
    let dep = 1;
    const { result, rerender } = renderHook(() => useReportData(() => fetcher(dep), [dep]));
    await waitFor(() => expect(result.current.data).toBe(2));
    dep = 5;
    rerender();
    await waitFor(() => expect(result.current.data).toBe(10));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reload re-runs the fetcher and clears a prior error', async () => {
    let shouldFail = true;
    const fetcher = vi.fn(async () => {
      if (shouldFail) throw new Error('fail');
      return 'ok';
    });
    const { result } = renderHook(() => useReportData(fetcher, []));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    shouldFail = false;
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data).toBe('ok'));
    expect(result.current.error).toBeNull();
  });

  it('ignores a stale response when deps change mid-flight', async () => {
    const resolvers: Array<(v: string) => void> = [];
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    let dep = 1;
    const { result, rerender } = renderHook(() => useReportData(() => fetcher(), [dep]));
    dep = 2;
    rerender();
    // Resolve the second (latest) call first, then the stale first call.
    act(() => resolvers[1]('latest'));
    await waitFor(() => expect(result.current.data).toBe('latest'));
    act(() => resolvers[0]('stale'));
    // Stale resolution must not overwrite the latest data.
    expect(result.current.data).toBe('latest');
  });
  /**
   * Invariant: a response is named by the request that produced it, in both
   * halves of the key.
   * Canonical adversarial input: a stale response landing after the selection
   * moved (testing contract, asynchronous).
   * Minimal mutation: read `keyForResultRef.current` inside `.then` instead of
   * snapshotting it when the run starts.
   * Test that fails under it: this one -- the in-flight response is stamped
   * with the new range's key and becomes that range's report.
   *
   * `deps` are deliberately held constant so no second fetch starts. That is
   * what isolates the defect: the run counter only moves when `run()` is
   * called, so between a render that changes the interpreter and the effect
   * that would start a new request, an old response is still allowed to
   * commit -- and it committed under whatever the interpreter said *then*.
   */
  it('names a response with the interpreter in force when it was requested', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const fetcher = () =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });

    // The interpreter closes over the range, exactly as the GEM report's does.
    // Passed as a prop rather than read from a mutable binding: React gives
    // each render its own `range`, so the arrow made during the first render
    // keeps saying 1Y no matter what later renders see. A shared `let` would
    // make every closure agree and hide the defect entirely.
    const { result, rerender } = renderHook(
      ({ range }: { range: string }) =>
        useReportData(fetcher, ['fixed'], {
          requestKey: `${range}|s1`,
          keyForResult: () => `${range}|s1`,
        }),
      { initialProps: { range: '1Y' } },
    );

    rerender({ range: '3M' });
    act(() => resolvers[0]('report-for-1Y'));

    await waitFor(() => expect(result.current.data).toBe('report-for-1Y'));
    // The payload is a 1Y report and must say so. Stamped `3M|s1` it becomes
    // the current selection's report, and every action offered beside it is
    // aimed at a range it does not describe.
    expect(result.current.dataKey).toBe('1Y|s1');
  });
});
