import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import { usePortfolioPeriodResult } from './usePortfolioPeriodResult';
import { netWorthApi } from '@/lib/net-worth';
import type { PortfolioPeriodResult } from '@/types/net-worth';

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsPeriodResult: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function result(
  overrides: Partial<PortfolioPeriodResult> = {},
): PortfolioPeriodResult {
  return {
    currency: 'CAD',
    startDate: '2026-01-02',
    startPriceDate: '2026-01-02',
    endDate: '2026-06-30',
    startValue: 10000,
    endValue: 20000,
    valueChange: 10000,
    netExternalFlows: 10000,
    knownFlowSubtotal: 10000,
    investmentResult: 0,
    returnPercent: 0,
    returnMethod: 'simple',
    complete: true,
    reasons: [],
    missingRatePairs: [],
    unpricedSecurityIds: [],
    unknownCashAccountIds: [],
    ...overrides,
  };
}

const base = {
  startDate: '2026-01-02',
  endDate: '2026-06-30',
  hasSeries: true,
};

describe('usePortfolioPeriodResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(result());
  });

  it('names the window rather than dating it, so the drawn window cannot widen it', async () => {
    // The chart DRAWS 1Y from a day before the anniversary so the first
    // plotted close precedes the year. Measuring over that window reports a
    // day the range does not name, and disagrees with the performance card
    // beside it, which resolves 1Y from the server's own preset.
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        range: '1y',
        firstPointIso: '2026-01-02',
        accountIds: 'a1,a2',
        displayCurrency: 'USD',
      }),
    );
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
    expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
      period: '1y',
      accountIds: 'a1,a2',
      displayCurrency: 'USD',
    });
    expect(hook.current.periodResult?.investmentResult).toBe(0);
  });

  it('measures 1D over a day, whatever window the chart drew for it', async () => {
    // `resolveRangePreset` widens 1D to a week so a daily fallback has more
    // than one point to plot. Sending that window measured a week's move under
    // a "1D" caption and dated it seven days back.
    renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        startDate: '2026-06-23',
        range: '1d',
        firstPointIso: '2026-06-30T13:30:00.000Z',
      }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
        period: '1d',
        accountIds: undefined,
        displayCurrency: undefined,
      }),
    );
  });

  it('asks for the all-time window, which has no start date to send', async () => {
    // `resolveRangePreset('all')` resolves to an empty start, so a dated
    // request was never made at all and both figures read n/a for every
    // account. The server opens the window on the scope's own history.
    renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        startDate: '',
        range: 'all',
        firstPointIso: '2019-04-01',
      }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: 'all' }),
      ),
    );
  });

  it('sends the day before the first point on screen for a range with no preset', async () => {
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        range: 'mtd',
        firstPointIso: '2026-07-01T13:30:00.000Z',
      }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
        startDate: '2026-01-02',
        endDate: '2026-06-30',
        baselineDate: '2026-06-30',
        accountIds: undefined,
        displayCurrency: undefined,
      }),
    );
    expect(hook.current.periodResult).not.toBeNull();
  });

  it('waits for the first point rather than guessing a prior close', async () => {
    renderHook(() =>
      usePortfolioPeriodResult({ ...base, range: 'mtd', firstPointIso: undefined }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalled(),
    );
  });

  it('asks nothing for a dated window while the series is empty', async () => {
    renderHook(() =>
      usePortfolioPeriodResult({ ...base, range: 'mtd', hasSeries: false }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalled(),
    );
  });

  it('leaves the figures unknown when the request fails', async () => {
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockRejectedValue(
      new Error('period unavailable'),
    );
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({ ...base, range: '1y', firstPointIso: '2026-01-02' }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalled(),
    );
    expect(hook.current.periodResult).toBeNull();
  });

  it('does not show one window\'s answer under another window\'s key', async () => {
    let range = '1y';
    const { result: hook, rerender } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        hasSeries: true,
        range,
        firstPointIso: '2026-01-02',
      }),
    );
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());

    // The next window's request hangs: the previous answer belongs to the
    // previous window and must not stand in for it.
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockImplementation(
      () => new Promise(() => {}),
    );
    range = '3m';
    rerender();
    expect(hook.current.periodResult).toBeNull();
  });
});
