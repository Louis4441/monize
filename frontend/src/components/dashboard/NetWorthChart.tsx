'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { MonthlyNetWorth } from '@/types/net-worth';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { NetWorthByAccountTypeChart } from '@/components/reports/NetWorthByAccountTypeChart';
import { WidgetHeading } from './widget-meta';
import { CARD_CLASS } from '@/components/ui/Card';

function NetWorthCompositionTooltip({
  active,
  payload,
  formatCurrency,
  labels,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; assets: number; liabilities: number } }>;
  formatCurrency: (v: number) => string;
  labels: { assets: string; liabilities: string; netWorth: string };
}) {
  const { formatPercent } = useNumberFormat();
  if (active && payload && payload.length) {
    const d = payload[0].payload;
    const total = d.assets + d.liabilities;
    const pct = (v: number) => (total > 0 ? formatPercent((v / total) * 100, 1) : '0%');
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-sm" style={{ color: chartColors.income }}>
          {labels.assets}: {formatCurrency(d.assets)} ({pct(d.assets)})
        </p>
        <p className="text-sm" style={{ color: chartColors.expense }}>
          {labels.liabilities}: {formatCurrency(d.liabilities)} ({pct(d.liabilities)})
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 pt-1 border-t border-gray-100 dark:border-gray-700">
          {labels.netWorth}: {formatCurrency(d.assets - d.liabilities)}
        </p>
      </div>
    );
  }
  return null;
}

interface NetWorthChartProps {
  data: MonthlyNetWorth[];
  isLoading: boolean;
}

export function NetWorthChart({ data, isLoading }: NetWorthChartProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyLabel, formatPercent } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const [chartType, setChartType] = useLocalStorage<'bar' | 'stacked'>(
    'dashboard.net-worth.chartType',
    'bar',
  );
  const compositionLabels = {
    assets: t('assetsVsLiabilities.assets'),
    liabilities: t('assetsVsLiabilities.liabilities'),
    netWorth: t('assetsVsLiabilities.netWorthLabel'),
  };

  const chartData = useMemo(() =>
    data.map((d) => ({
      // Raw YYYY-MM keeps the X-axis category stable and locale-independent;
      // the tick formatter localizes it to a short month for display.
      month: d.month,
      key: d.month,
      name: formatChartDate(`${d.month}-01`, 'MMM yyyy'),
      netWorth: Math.round(d.netWorth),
      assets: Math.round(d.assets),
      liabilities: Math.round(d.liabilities),
      byAccountType: d.byAccountType,
    })),
  [data, formatChartDate]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const current = chartData[chartData.length - 1].netWorth;
    const initial = chartData[0].netWorth;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { current, change, changePercent };
  }, [chartData]);

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
        <WidgetHeading id="net-worth" href="/reports/net-worth" className="mb-4">
          {t('netWorth.title')}
        </WidgetHeading>
        <div className="animate-pulse space-y-3">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-40 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
        <WidgetHeading id="net-worth" href="/reports/net-worth" className="mb-4">
          {t('netWorth.title')}
        </WidgetHeading>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t('netWorth.empty')}
        </p>
      </div>
    );
  }

  const isPositive = summary!.change >= 0;

  return (
    // Height comes from the grid's stretch, never from `h-full`: see
    // WidgetCard for why a percentage height on an auto row overflows.
    <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px] flex flex-col`}>
      <div className="flex items-center justify-between mb-1">
        <WidgetHeading id="net-worth" href="/reports/net-worth">
          {t('netWorth.title')}
        </WidgetHeading>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-sm text-gray-500 dark:text-gray-400">{t('netWorth.past12Months')}</span>
          <ChartViewToggle
            value={chartType}
            onChange={(v) => setChartType(v as 'bar' | 'stacked')}
            options={['bar', 'stacked']}
          />
        </div>
      </div>
      <div className="mb-3">
        <div className={`text-2xl font-bold ${
          summary!.current >= 0 ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400'
        }`}>
          {formatCurrency(summary!.current)}
        </div>
        <div className={`text-sm font-medium ${
          isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
        }`}>
          {isPositive ? '+' : ''}{formatCurrency(summary!.change)} ({isPositive ? '+' : ''}{formatPercent(summary!.changePercent, 1)})
        </div>
      </div>
      <div className="h-80">
        {chartType === 'stacked' ? (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={chartData} stackOffset="expand" margin={{ top: 12, right: 12, left: 12, bottom: 0 }}>
              <YAxis hide domain={[0, 1]} />
              <XAxis
                dataKey="month"
                tick={{ fill: chartColors.axis, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                tickFormatter={(value: string) => formatChartDate(`${value}-01`, 'MMM')}
              />
              <Tooltip
                content={<NetWorthCompositionTooltip formatCurrency={formatCurrency} labels={compositionLabels} />}
                cursor={{ fill: chartColors.grid, fillOpacity: 0.35 }}
              />
              <Bar dataKey="assets" stackId="nw" fill={chartColors.income} />
              <Bar dataKey="liabilities" stackId="nw" fill={chartColors.expense} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          // Stacked by account type: what each type adds to (or, owed, takes
          // from) net worth, with net worth itself as the line across them.
          <NetWorthByAccountTypeChart
            data={chartData}
            formatCurrency={formatCurrency}
            formatXTick={(value) => formatChartDate(`${value}-01`, 'MMM')}
            fontSize={11}
            valueLabels="vertical"
            formatValueLabel={formatCurrencyLabel}
            margin={{ top: 52, right: 12, left: 12, bottom: 0 }}
          />
        )}
      </div>
      <button
        onClick={() => router.push('/reports/net-worth')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        {t('netWorth.viewReport')}
      </button>
    </div>
  );
}
