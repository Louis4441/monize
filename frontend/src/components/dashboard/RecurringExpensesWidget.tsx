'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartSeriesColor } from '@/lib/chart-colors';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { RecurringExpensesChart, RecurringSlice } from './RecurringExpensesChart';
import { RECURRING_EXPENSES_DEFAULT, RECURRING_RANGES, RecurringConfig } from './widget-config';

const WIDGET_ID = 'recurring-expenses';
const MIN_OCCURRENCE_OPTIONS = [2, 3, 4, 5, 6];

interface RecurringExpensesWidgetProps {
  isLoading: boolean;
}

export function RecurringExpensesWidget({ isLoading }: RecurringExpensesWidgetProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyCompact } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<RecurringConfig>(
    WIDGET_ID,
    RECURRING_EXPENSES_DEFAULT,
  );

  const { data: response, isLoading: dataLoading } = useReportData(
    () => builtInReportsApi.getRecurringExpenses(config.minOccurrences, config.range),
    [config.minOccurrences, config.range],
  );

  const chartData = useMemo<RecurringSlice[]>(
    () =>
      (response?.data ?? []).slice(0, 10).map((item, index) => ({
        ...item,
        color: chartSeriesColor(index),
      })),
    [response],
  );

  const monthlyEstimate = response?.summary.monthlyEstimate ?? 0;

  const handleSliceClick = (payeeId: string | null) => {
    if (payeeId) router.push(`/transactions?payeeId=${payeeId}`);
  };

  const rangeLabel = (range: string) =>
    t(`widgets.rangeLabels.${range}` as Parameters<typeof t>[0]);

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={RECURRING_RANGES}
          labels={Object.fromEntries(RECURRING_RANGES.map((r) => [r, rangeLabel(r)]))}
          value={config.range}
          onChange={(range) => updateConfig({ range: range as RecurringConfig['range'] })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('recurringExpenses.minOccurrences')}>
        <select
          value={config.minOccurrences}
          onChange={(e) => updateConfig({ minOccurrences: Number(e.target.value) })}
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
        >
          {MIN_OCCURRENCE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {t('recurringExpenses.minOccurrencesOption', { count: n })}
            </option>
          ))}
        </select>
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.view')}>
        <WidgetSegmentedControl
          value={config.view}
          onChange={(view) => updateConfig({ view })}
          options={[
            { value: 'callouts', label: t('recurringExpenses.viewCallouts') },
            { value: 'legend', label: t('recurringExpenses.viewLegend') },
          ]}
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('recurringExpenses.title')}
      widgetId={WIDGET_ID}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">{rangeLabel(config.range)}</span>
      }
      configControls={configControls}
      configTitle={t('recurringExpenses.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('recurringExpenses.empty')}</WidgetMessage>
      ) : (
        <>
          <RecurringExpensesChart
            slices={chartData}
            view={config.view}
            onSliceClick={handleSliceClick}
          />
          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-sm flex-shrink-0">
            <span className="text-gray-500 dark:text-gray-400">{t('recurringExpenses.monthlyEstimate')}</span>
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {formatCurrencyCompact(monthlyEstimate)}
            </span>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
