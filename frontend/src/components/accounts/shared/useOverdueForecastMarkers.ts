'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { ChartMarker } from '@/components/transactions/BalanceHistoryChart';
import type { BalanceForecastState } from './balance-forecast-state';

/**
 * The balance chart's marker for the overdue occurrences a projection applied
 * on its first day (discussion #1784): one dot on that day whose tooltip says
 * how many, so the drop has a visible cause. None when nothing was overdue, or
 * when what was overdue nets to nothing and so moves no point.
 *
 * Both account detail views draw the same projection, so they read the marker
 * from here rather than each composing their own.
 */
export function useOverdueForecastMarkers(
  state: BalanceForecastState,
): ChartMarker[] {
  const t = useTranslations('accountDetail');
  const { overdue } = state;
  return useMemo(() => {
    if (overdue === null || overdue.amount === 0) return [];
    return [
      {
        date: overdue.date,
        direction: overdue.amount > 0 ? 'in' : 'out',
        label: t('forecastOverdue', { count: overdue.count }),
      },
    ];
  }, [overdue, t]);
}
