'use client';

import { useTranslations } from 'next-intl';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { isLiabilityAccountType, type AccountType } from '@/types/account';
import type { MonthlyNetWorth } from '@/types/net-worth';
import { chartColors } from '@/lib/chart-colors';
import {
  netWorthAccountTypeColor,
  netWorthAccountTypes,
  netWorthStackTop,
} from '@/lib/net-worth-account-types';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';

/** One month as the chart draws it. */
export interface NetWorthByAccountTypePoint {
  /** The x-axis category: stable and locale-independent. */
  key: string;
  /** The month as the tooltip names it. */
  name: string;
  netWorth: number;
  byAccountType?: MonthlyNetWorth['byAccountType'];
}

interface NetWorthByAccountTypeChartProps {
  data: readonly NetWorthByAccountTypePoint[];
  formatCurrency: (value: number) => string;
  /** The x-axis tick label for a point's `key`. */
  formatXTick: (key: string) => string;
  /** Explicit x-axis ticks, where the caller thins them. */
  xTicks?: string[];
  /** Draws a y-axis with these labels; the axis is hidden without it. */
  formatYTick?: (value: number) => string;
  fontSize?: number;
  margin?: { top: number; right: number; left: number; bottom: number };
  /** Each month's net worth printed above its bar, upright or rotated. */
  valueLabels?: 'horizontal' | 'vertical';
  formatValueLabel?: (value: number) => string;
}

interface TooltipBodyProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  types: readonly AccountType[];
  typeLabel: (type: AccountType) => string;
  netWorthLabel: string;
  formatCurrency: (value: number) => string;
}

/** The month's net worth and what each account type in it contributes. */
function NetWorthByAccountTypeTooltip({
  active,
  payload,
  types,
  typeLabel,
  netWorthLabel,
  formatCurrency,
}: TooltipBodyProps) {
  const point = active ? (payload?.[0]?.payload as NetWorthByAccountTypePoint | undefined) : undefined;
  if (!point) return null;
  // Only what the month holds: a type at zero this month contributes nothing.
  const rows = types.filter((type) => {
    const value = point.byAccountType?.[type];
    return value !== undefined && value !== 0;
  });
  return (
    <ChartTooltipPanel>
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{point.name}</p>
      {rows.map((type) => (
        <p key={type} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <span
            aria-hidden
            className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
            style={{ backgroundColor: netWorthAccountTypeColor(type) }}
          />
          <span>{typeLabel(type)}</span>
          <span className="ml-auto pl-4 tabular-nums">{formatCurrency(point.byAccountType![type]!)}</span>
        </p>
      ))}
      <p
        className={`flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100 ${
          rows.length > 0 ? 'mt-1 pt-1 border-t border-gray-100 dark:border-gray-700' : ''
        }`}
      >
        <span>{netWorthLabel}</span>
        <span className="ml-auto pl-4 tabular-nums">{formatCurrency(point.netWorth)}</span>
      </p>
    </ChartTooltipPanel>
  );
}

/**
 * Net worth month by month as bars stacked by account type: what is held
 * stacks up from zero and what is owed down from it, each type in its own
 * colour, with net worth itself drawn as a line across them. Shared by the
 * Net Worth Over Time report and the dashboard widget.
 *
 * Every figure is the server's (`MonthlyNetWorth.byAccountType`). A response
 * without the breakdown (an older backend mid-deploy) draws net worth alone.
 */
export function NetWorthByAccountTypeChart({
  data,
  formatCurrency,
  formatXTick,
  xTicks,
  formatYTick,
  fontSize = 12,
  margin = { top: 10, right: 10, left: 0, bottom: 0 },
  valueLabels,
  formatValueLabel = formatCurrency,
}: NetWorthByAccountTypeChartProps) {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const types = netWorthAccountTypes(data);
  const typeLabel = (type: AccountType) => tCommon(`accountTypes.${type}`);
  const netWorthLabel = t('netWorth.seriesNetWorth');

  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <ComposedChart data={data as NetWorthByAccountTypePoint[]} stackOffset="sign" margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
        <XAxis
          dataKey="key"
          tick={{ fill: chartColors.axis, fontSize }}
          tickLine={false}
          {...(xTicks ? { ticks: xTicks } : { interval: 'preserveStartEnd' as const })}
          tickFormatter={formatXTick}
        />
        <YAxis
          hide={!formatYTick}
          tickFormatter={formatYTick}
          tick={{ fill: chartColors.axis, fontSize }}
        />
        <Tooltip
          content={
            <NetWorthByAccountTypeTooltip
              types={types}
              typeLabel={typeLabel}
              netWorthLabel={netWorthLabel}
              formatCurrency={formatCurrency}
            />
          }
          cursor={{ fill: chartColors.grid, fillOpacity: 0.35 }}
        />
        <Legend wrapperStyle={{ fontSize }} />
        <ReferenceLine y={0} stroke={chartColors.axis} strokeDasharray="3 3" />
        {types.map((type) => (
          <Bar
            key={type}
            dataKey={(point: NetWorthByAccountTypePoint) => point.byAccountType?.[type]}
            stackId="net-worth"
            name={typeLabel(type)}
            fill={netWorthAccountTypeColor(type)}
            // The legend names the asset types the bars are made of; what is
            // owed is read from the tooltip and the net worth line, not the
            // bars, so it takes no legend entry.
            legendType={isLiabilityAccountType(type) ? 'none' : undefined}
          />
        ))}
        {types.length === 0 && (
          <Bar dataKey="netWorth" name={netWorthLabel} fill={chartColors.primary} radius={[4, 4, 0, 0]} />
        )}
        {types.length > 0 && (
          <Line
            dataKey="netWorth"
            name={netWorthLabel}
            stroke={chartColors.primary}
            strokeWidth={2}
            dot={{ r: 3, fill: chartColors.primary, stroke: chartColors.surface, strokeWidth: 1 }}
            isAnimationActive={false}
          />
        )}
        {valueLabels && (
          // Invisible: it only carries the labels to the top of each bar,
          // where net worth is printed whatever the bar is made of.
          <Line
            dataKey={(point: NetWorthByAccountTypePoint) => netWorthStackTop(point)}
            stroke="none"
            dot={false}
            activeDot={false}
            legendType="none"
            tooltipType="none"
            isAnimationActive={false}
          >
            <LabelList
              dataKey="netWorth"
              position="top"
              angle={valueLabels === 'vertical' ? -90 : 0}
              offset={valueLabels === 'vertical' ? 6 : 5}
              textAnchor={valueLabels === 'vertical' ? 'start' : 'middle'}
              formatter={(value: unknown) => formatValueLabel(Number(value))}
              style={{
                fill: chartColors.axis,
                fontSize: 11,
                fontWeight: 600,
                ...(valueLabels === 'vertical' && { dominantBaseline: 'central' as const }),
              }}
            />
          </Line>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
