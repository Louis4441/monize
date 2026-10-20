'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { RecurringExpenseItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ChartLegend } from '@/components/ui/ChartLegend';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { DEFAULT_CALLOUT_OPTIONS, layoutCallouts } from './recurring-callout-layout';

export type RecurringSlice = RecurringExpenseItem & { color: string };

interface RecurringExpensesChartProps {
  slices: RecurringSlice[];
  view: 'callouts' | 'legend';
  onSliceClick: (payeeId: string | null) => void;
}

interface Size {
  width: number;
  height: number;
}

/** The element's content box, once a ResizeObserver has reported it. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * The Top Recurring Expenses donut, with each payee named either in a box
 * beside the chart and a leader line to its slice, or in a legend under it.
 *
 * The callout boxes are positioned by `layoutCallouts`, which keeps them apart
 * and inside the measured chart area. Where the area is too small for that,
 * the chart falls back to the legend rather than drawing boxes that collide or
 * spill out of the card. Showing the legend only shrinks the chart area, so
 * the fallback cannot flip back and forth.
 *
 * Both views share the donut's angles (`DEFAULT_CALLOUT_OPTIONS`), so a
 * leader line starts on the slice it names.
 */
export function RecurringExpensesChart({ slices, view, onSliceClick }: RecurringExpensesChartProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatCurrencyCompact } = useNumberFormat();
  const [areaRef, size] = useElementSize<HTMLDivElement>();

  const layout = useMemo(
    () =>
      view === 'callouts' && size
        ? layoutCallouts(
            slices.map((s) => s.totalAmount),
            size.width,
            size.height,
          )
        : null,
    [view, size, slices],
  );
  // Until the area is measured the callout view draws only the donut, so a
  // legend does not flash up and vanish again.
  const showLegend = view === 'legend' || (size !== null && layout === null);

  const tooltip = (
    <Tooltip
      // Above the callout boxes, which are positioned after the chart.
      wrapperStyle={{ zIndex: 10 }}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0].payload as RecurringSlice;
        return (
          <ChartTooltipPanel>
            <p className="font-medium text-gray-900 dark:text-gray-100">{d.payeeName}</p>
            <p className="text-gray-600 dark:text-gray-400">{formatCurrency(d.totalAmount)}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('recurringExpenses.occurrences', { count: d.occurrences })}
            </p>
          </ChartTooltipPanel>
        );
      }}
    />
  );

  const cells = slices.map((entry) => <Cell key={entry.payeeId || entry.payeeName} fill={entry.color} />);
  const pieProps = {
    data: slices,
    paddingAngle: DEFAULT_CALLOUT_OPTIONS.paddingAngle,
    startAngle: DEFAULT_CALLOUT_OPTIONS.startAngle,
    endAngle: DEFAULT_CALLOUT_OPTIONS.endAngle,
    dataKey: 'totalAmount',
    nameKey: 'payeeName',
    cursor: 'pointer',
    onClick: (d: unknown) => onSliceClick((d as RecurringSlice).payeeId),
  } as const;

  return (
    <>
      <div
        ref={areaRef}
        data-testid="recurring-chart-area"
        className={`relative flex-1 ${view === 'callouts' ? 'min-h-[260px]' : 'min-h-[240px]'}`}
      >
        {layout && size ? (
          <>
            {/* Out of the flow like everything else in the area: a chart drawn
                at the measured size and left in the flow would hold the area
                at that size, so it could grow with the card but never shrink. */}
            <div data-testid="recurring-chart-plot" className="absolute inset-0">
              <PieChart width={size.width} height={size.height}>
                <Pie
                  {...pieProps}
                  cx={layout.cx}
                  cy={layout.cy}
                  innerRadius={layout.innerRadius}
                  outerRadius={layout.outerRadius}
                >
                  {cells}
                </Pie>
                {tooltip}
              </PieChart>
            </div>
            <svg
              className="pointer-events-none absolute inset-0"
              width={size.width}
              height={size.height}
              aria-hidden="true"
            >
              {layout.callouts.map((callout) => {
                const color = slices[callout.index].color;
                return (
                  <g key={callout.index}>
                    <polyline
                      points={callout.line.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke={color}
                      strokeWidth={1}
                    />
                    <circle cx={callout.line[0].x} cy={callout.line[0].y} r={2} fill={color} />
                  </g>
                );
              })}
            </svg>
            <ul aria-label={t('recurringExpenses.title')}>
              {layout.callouts.map((callout) => {
                const slice = slices[callout.index];
                const content = (
                  <>
                    <span className="block truncate font-medium text-gray-900 dark:text-gray-100">
                      {slice.payeeName}
                    </span>
                    <span className="block truncate tabular-nums text-gray-600 dark:text-gray-400">
                      {formatCurrencyCompact(slice.totalAmount)}
                    </span>
                  </>
                );
                const boxClass =
                  'flex h-full w-full flex-col justify-center rounded-md border border-gray-200 dark:border-gray-700 border-l-4 px-2 text-left text-xs leading-tight';
                return (
                  <li
                    key={slice.payeeId || slice.payeeName}
                    className="absolute"
                    style={{
                      left: callout.box.x,
                      top: callout.box.y,
                      width: callout.box.width,
                      height: callout.box.height,
                    }}
                  >
                    {slice.payeeId ? (
                      <button
                        type="button"
                        title={slice.payeeName}
                        onClick={() => onSliceClick(slice.payeeId)}
                        className={`${boxClass} ${HOVER_ROW_ON_CARD} cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500`}
                        style={{ borderLeftColor: slice.color }}
                      >
                        {content}
                      </button>
                    ) : (
                      <div title={slice.payeeName} className={boxClass} style={{ borderLeftColor: slice.color }}>
                        {content}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <div className="absolute inset-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie {...pieProps} cx="50%" cy="50%" innerRadius="55%" outerRadius="85%">
                  {cells}
                </Pie>
                {tooltip}
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {showLegend && (
        <ChartLegend
          className="mt-3 flex-shrink-0"
          columnsClassName="sm:grid-cols-2"
          items={slices.map((slice) => ({
            key: slice.payeeId || slice.payeeName,
            name: slice.payeeName,
            color: slice.color,
            trailing: formatCurrencyCompact(slice.totalAmount),
            onClick: () => onSliceClick(slice.payeeId),
            disabled: !slice.payeeId,
          }))}
        />
      )}
    </>
  );
}
