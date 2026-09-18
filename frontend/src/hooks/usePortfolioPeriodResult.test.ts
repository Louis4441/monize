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

  it('asks for the window it was given and returns what the server says', async () => {
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
      startDate: '2026-01-02',
      endDate: '2026-06-30',
      baselineDate: undefined,
      accountIds: 'a1,a2',
      displayCurrency: 'USD',
    });
    expect(hook.current.periodResult?.investmentResult).toBe(0);
    expect(hook.current.usesPriorClose).toBe(false);
  });

  it('sends the day before the first point on screen for a prior-close range', async () => {
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        range: 'mtd',
        firstPointIso: '2026-07-01T13:30:00.000Z',
      }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ baselineDate: '2026-06-30' }),
      ),
    );
    expect(hook.current.usesPriorClose).toBe(true);
  });

  it('waits for the first point rather than guessing a prior close', async () => {
    renderHook(() =>
      usePortfolioPeriodResult({ ...base, range: '1w', firstPointIso: undefined }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalled(),
    );
  });

  it('asks nothing while the series is empty', async () => {
    renderHook(() =>
      usePortfolioPeriodResult({ ...base, range: '1y', hasSeries: false }),
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
    let window = { startDate: '2026-01-02', endDate: '2026-06-30' };
    const { result: hook, rerender } = renderHook(() =>
      usePortfolioPeriodResult({
        ...window,
        hasSeries: true,
        range: '1y',
        firstPointIso: '2026-01-02',
      }),
    );
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());

    // The next window's request hangs: the previous answer belongs to the
    // previous window and must not stand in for it.
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockImplementation(
      () => new Promise(() => {}),
    );
    window = { startDate: '2025-01-02', endDate: '2025-06-30' };
    rerender();
    expect(hook.current.periodResult).toBeNull();
  });
});
