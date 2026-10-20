import { describe, expect, it } from 'vitest';
import { renderHook } from '@/test/render';
import {
  EMPTY_BALANCE_FORECAST_STATE,
  type BalanceForecastState,
} from './balance-forecast-state';
import { useOverdueForecastMarkers } from './useOverdueForecastMarkers';

const withOverdue = (
  overdue: BalanceForecastState['overdue'],
): BalanceForecastState => ({ ...EMPTY_BALANCE_FORECAST_STATE, overdue });

describe('useOverdueForecastMarkers (discussion #1784)', () => {
  it('marks the first projected day with how many bills were overdue', () => {
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 2, amount: -300 })),
    );
    expect(result.current).toEqual([
      { date: '2026-03-02', direction: 'out', label: 'Includes 2 overdue scheduled transactions' },
    ]);
  });

  it('points the marker up when the overdue occurrences net to money in', () => {
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 1, amount: 120 })),
    );
    expect(result.current).toEqual([
      { date: '2026-03-02', direction: 'in', label: 'Includes 1 overdue scheduled transaction' },
    ]);
  });

  it('draws nothing when nothing is overdue', () => {
    const { result } = renderHook(() => useOverdueForecastMarkers(withOverdue(null)));
    expect(result.current).toEqual([]);
  });

  it('draws nothing when the overdue occurrences net to zero', () => {
    const { result } = renderHook(() =>
      useOverdueForecastMarkers(withOverdue({ date: '2026-03-02', count: 2, amount: 0 })),
    );
    expect(result.current).toEqual([]);
  });
});
