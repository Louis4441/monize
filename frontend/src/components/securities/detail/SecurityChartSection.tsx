'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import {
  BalanceHistoryChart,
  type ChartMarker,
} from '@/components/transactions/BalanceHistoryChart';
import { useDateRange } from '@/hooks/useDateRange';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  CHART_RANGES,
  buildChartSeries,
  filterPriceWindow,
  type SecurityChartMode,
  type SecurityPricePoint,
  type QuantityStep,
} from '@/lib/security-detail';
import type {
  Security,
  SecurityHistoryTransaction,
} from '@/types/investment';

interface SecurityChartSectionProps {
  security: Security;
  /** Full close-price history, oldest first. */
  prices: readonly SecurityPricePoint[];
  /** Position size over time, for the investment-value series. */
  quantitySteps: readonly QuantityStep[];
  trades: readonly SecurityHistoryTransaction[];
  isLoading: boolean;
  mode: SecurityChartMode;
  onModeChange: (mode: SecurityChartMode) => void;
}

const MODES: readonly SecurityChartMode[] = ['price', 'value', 'return'];

/** Which way each action moved the position; the rest carry no shares. */
const MARKER_DIRECTION: Partial<
  Record<SecurityHistoryTransaction['action'], 'in' | 'out'>
> = {
  BUY: 'in',
  REINVEST: 'in',
  TRANSFER_IN: 'in',
  ADD_SHARES: 'in',
  SELL: 'out',
  TRANSFER_OUT: 'out',
  REMOVE_SHARES: 'out',
};

/**
 * The page's main chart: the same chart the price-history modal and the account
 * pages draw, given a choice of series and a time window.
 *
 * The three series answer three different questions from the same history --
 * what one unit cost, what the whole position was worth, and how far the price
 * has moved in the window. Only the third is not money, which is why the chart
 * is told to write it as a percentage.
 */
export function SecurityChartSection({
  security,
  prices,
  quantitySteps,
  trades,
  isLoading,
  mode,
  onModeChange,
}: SecurityChartSectionProps) {
  const t = useTranslations('securityDetail');
  const ts = useTranslations('securities');
  const { formatQuantity } = useNumberFormat();

  // Per-security key, so switching securities does not inherit the last one's
  // window while the choice still survives leaving and coming back.
  const { dateRange, setDateRange, resolvedRange } = useDateRange({
    defaultRange: '1y',
    storageKey: `securityDetail:range:${security.id}`,
  });

  const series = useMemo(() => {
    const window = filterPriceWindow(
      prices,
      resolvedRange.start,
      resolvedRange.end,
    );
    return buildChartSeries(window, quantitySteps, mode);
  }, [prices, quantitySteps, resolvedRange.start, resolvedRange.end, mode]);

  const markers = useMemo<ChartMarker[]>(
    () =>
      trades.flatMap((trade) => {
        const direction = MARKER_DIRECTION[trade.action];
        if (!direction || trade.quantity === null) return [];
        return [
          {
            date: trade.transactionDate.slice(0, 10),
            direction,
            label: ts(
              direction === 'in'
                ? 'priceHistory.markers.bought'
                : 'priceHistory.markers.sold',
              {
                quantity: formatQuantity(Math.abs(Number(trade.quantity))),
                account: trade.accountName,
              },
            ),
          },
        ];
      }),
    [trades, ts, formatQuantity],
  );

  return (
    // No wrapping card: `BalanceHistoryChart` already draws one, and nesting a
    // second would double the border and padding. The controls sit directly
    // above it instead, as they do on the portfolio charts.
    <div>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="group"
          aria-label={t('chart.seriesAriaLabel')}
          className="flex flex-wrap gap-2"
        >
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onModeChange(option)}
              aria-pressed={mode === option}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                mode === option
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600',
              )}
            >
              {t(`chart.modes.${option}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
        <DateRangeSelector
          ranges={CHART_RANGES}
          value={dateRange}
          onChange={setDateRange}
          size="sm"
        />
      </div>

      {/* The chart brings its own card chrome, loading skeleton and no-data
          state; this section only supplies the controls above it. */}
      <BalanceHistoryChart
        data={series}
        isLoading={isLoading}
        currencyCode={security.currencyCode}
        accountName={security.symbol}
        title={t(`chart.titles.${mode}` as Parameters<typeof t>[0])}
        markers={mode === 'return' ? undefined : markers}
        neutralValues={mode !== 'return'}
        precise={mode === 'price'}
        valueFormat={mode === 'return' ? 'percent' : 'currency'}
      />
    </div>
  );
}
