'use client';

import { Fragment, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { MonthlyBreakdownCategoryRow } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useReportData } from '@/hooks/useReportData';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ReportError } from '@/components/reports/ReportError';
import { exportToCsv } from '@/lib/csv-export';

const RANGE_STORAGE_KEY = 'monize-reports-monthly-category-breakdown-range';
const PERCENTAGES_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-percentages';

// Deviation thresholds (fraction of the non-zero average) mirroring yaffa.
const DEVIATION_LEVEL_1 = 0.05;
const DEVIATION_LEVEL_2 = 0.1;
const DEVIATION_LEVEL_3 = 0.15;

// Minimum non-zero months before deviation highlighting kicks in.
const MIN_NON_ZERO_FOR_DEVIATION = 3;

/**
 * Rotating palette for section headers and subtotal rows. Each entry pairs a
 * header background/text class set with a subtotal accent border so adjacent
 * parent groups stay visually distinct (translated from yaffa's Bootstrap
 * s-section-N classes to Tailwind, dark-mode aware).
 */
const SECTION_PALETTE = [
  'bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
  'bg-orange-50 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
  'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200',
  'bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
  'bg-purple-50 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
  'bg-pink-50 text-pink-800 dark:bg-pink-900/30 dark:text-pink-200',
  'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  'bg-cyan-50 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
];
const OTHER_PALETTE =
  'bg-gray-100 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200';

// Top-level group header bars. Income is rendered first (green), expenses
// second (red) so the two halves of the report are visually unmistakable.
const INCOME_GROUP_CLASS =
  'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100';
const EXPENSE_GROUP_CLASS =
  'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100';

const OTHER_INCOME_KEY = '__other_income__';
const OTHER_EXPENSE_KEY = '__other_expense__';
const isOtherKey = (key: string): boolean =>
  key === OTHER_INCOME_KEY || key === OTHER_EXPENSE_KEY;

// Deviation cell background classes. "high" = above average, "low" = below.
const DEVIATION_CLASS: Record<string, string> = {
  'high-1': 'bg-red-50 dark:bg-red-900/20',
  'high-2': 'bg-red-100 dark:bg-red-900/40',
  'high-3': 'bg-red-200 dark:bg-red-900/60',
  'low-1': 'bg-green-50 dark:bg-green-900/20',
  'low-2': 'bg-green-100 dark:bg-green-900/40',
  'low-3': 'bg-green-200 dark:bg-green-900/60',
};

interface ProcessedRow {
  categoryId: string | null;
  displayName: string;
  isIncome: boolean;
  values: Record<string, number>;
  total: number;
  avg: number;
  nonZeroAvg: number;
  nonZeroCount: number;
}

interface Section {
  title: string;
  paletteClass: string;
  rows: ProcessedRow[];
  subtotals: Record<string, number>;
  subtotalSum: number;
  subtotalAvg: number;
  allCategoryIds: string[];
  isIncome: boolean;
}

const SCALE = 10000;
function roundMoney(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}
function sumMoney(values: number[]): number {
  const units = values.reduce(
    (acc, v) => acc + (Number.isFinite(v) ? Math.round(v * SCALE) : 0),
    0,
  );
  return units / SCALE;
}

function processGroup(
  rows: MonthlyBreakdownCategoryRow[],
  months: string[],
  monthCount: number,
  sectionIsIncome: boolean,
): Omit<Section, 'title' | 'paletteClass' | 'isIncome'> {
  const processed: ProcessedRow[] = rows
    .map((row) => {
      // Re-express every month value in the section's sign convention so the
      // subtotal is correct even when a subcategory's net runs against the
      // section (e.g. a refund-heavy expense subcategory whose net is
      // positive must still subtract from the expense subtotal). The raw net
      // (deposits - withdrawals) is recovered from the row's own convention,
      // then re-signed for the section.
      const values: Record<string, number> = {};
      for (const m of months) {
        const own = row.valuesByMonth[m] || 0;
        const rawNet = row.isIncome ? own : -own;
        values[m] = roundMoney(sectionIsIncome ? rawNet : -rawNet);
      }
      const total = sumMoney(months.map((m) => values[m] || 0));
      const nonZeroCount = months.filter((m) => (values[m] || 0) !== 0).length;
      const avg = nonZeroCount > 0 ? total / monthCount : 0;
      const nonZeroAvg = nonZeroCount > 0 ? total / nonZeroCount : 0;
      return {
        categoryId: row.categoryId,
        displayName: row.categoryName,
        isIncome: sectionIsIncome,
        values,
        total: roundMoney(total),
        avg: roundMoney(avg),
        nonZeroAvg,
        nonZeroCount,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const subtotals: Record<string, number> = {};
  for (const m of months) {
    subtotals[m] = sumMoney(processed.map((r) => r.values[m] || 0));
  }
  const subtotalSum = sumMoney(processed.map((r) => r.total));
  const subtotalAvg = roundMoney(subtotalSum / monthCount);
  const allCategoryIds = processed
    .map((r) => r.categoryId)
    .filter((id): id is string => id != null);

  return { rows: processed, subtotals, subtotalSum, subtotalAvg, allCategoryIds };
}

function deviationClass(
  value: number,
  avg: number,
  nonZeroCount: number,
  isIncome: boolean,
): string {
  if (nonZeroCount < MIN_NON_ZERO_FOR_DEVIATION || value === 0 || avg === 0) {
    return '';
  }
  const deviation = (value - avg) / avg;
  // For expenses, above average is bad (red); for income, above is good (green).
  const above = isIncome ? 'low' : 'high';
  const below = isIncome ? 'high' : 'low';

  if (deviation > DEVIATION_LEVEL_3) return DEVIATION_CLASS[`${above}-3`];
  if (deviation > DEVIATION_LEVEL_2) return DEVIATION_CLASS[`${above}-2`];
  if (deviation > DEVIATION_LEVEL_1) return DEVIATION_CLASS[`${above}-1`];
  if (deviation < -DEVIATION_LEVEL_3) return DEVIATION_CLASS[`${below}-3`];
  if (deviation < -DEVIATION_LEVEL_2) return DEVIATION_CLASS[`${below}-2`];
  if (deviation < -DEVIATION_LEVEL_1) return DEVIATION_CLASS[`${below}-1`];
  return '';
}

export function MonthlyCategoryBreakdownReport() {
  const router = useRouter();
  const t = useTranslations('reports');
  const { formatCurrency } = useNumberFormat();
  const { formatMonth } = useDateFormat();
  const otherExpensesLabel = t('monthlyCategoryBreakdown.otherExpenses');
  const otherIncomeLabel = t('monthlyCategoryBreakdown.otherIncome');
  const [showPercentages, setShowPercentages] = useLocalStorage<boolean>(
    PERCENTAGES_STORAGE_KEY,
    false,
  );
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = useDateRange({ defaultRange: '6m', storageKey: RANGE_STORAGE_KEY });

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getMonthlyCategoryBreakdown({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
  );

  const currency = data?.currency;

  const model = useMemo(() => {
    if (!data) return null;
    const months = data.months;
    const monthCount = months.length || 1;
    const rows = data.data;

    // Group categories by parent. A category with a parent forms (or joins) a
    // section keyed by that parent; parentless categories collect into the
    // "Other income" / "Other expenses" buckets according to their own type.
    // The whole section is classified income or expense from the parent's flag
    // (falling back to the row's own flag when the parent is unknown).
    interface RawGroup {
      key: string;
      title: string;
      isIncome: boolean;
      list: MonthlyBreakdownCategoryRow[];
    }
    const groups = new Map<string, RawGroup>();
    const addRow = (
      key: string,
      title: string,
      isIncome: boolean,
      row: MonthlyBreakdownCategoryRow,
    ) => {
      const existing = groups.get(key);
      groups.set(
        key,
        existing
          ? { ...existing, list: [...existing.list, row] }
          : { key, title, isIncome, list: [row] },
      );
    };
    for (const row of rows) {
      if (row.parentId && row.parentName) {
        addRow(
          row.parentId,
          row.parentName,
          row.parentIsIncome ?? row.isIncome,
          row,
        );
      } else if (row.isIncome) {
        addRow(OTHER_INCOME_KEY, otherIncomeLabel, true, row);
      } else {
        addRow(OTHER_EXPENSE_KEY, otherExpensesLabel, false, row);
      }
    }

    // Order each half alphabetically by category name, with the catch-all
    // "Other" bucket pinned to the end.
    const orderGroups = (income: boolean): RawGroup[] =>
      Array.from(groups.values())
        .filter((g) => g.isIncome === income)
        .sort((a, b) => {
          const aOther = isOtherKey(a.key);
          const bOther = isOtherKey(b.key);
          if (aOther !== bOther) return aOther ? 1 : -1;
          return a.title.localeCompare(b.title);
        });
    const orderedGroups = [...orderGroups(true), ...orderGroups(false)];

    let paletteCount = 0;
    const sections: Section[] = orderedGroups.map((g) => {
      const other = isOtherKey(g.key);
      const paletteClass = other
        ? OTHER_PALETTE
        : SECTION_PALETTE[paletteCount % SECTION_PALETTE.length];
      if (!other) paletteCount += 1;
      const group = processGroup(g.list, months, monthCount, g.isIncome);
      return { title: g.title, paletteClass, isIncome: g.isIncome, ...group };
    });

    const incomeSections = sections.filter((s) => s.isIncome);
    const expenseSections = sections.filter((s) => !s.isIncome);

    // Group totals are the sum of section subtotals (already positive
    // magnitudes in each section's own convention).
    const monthlyExpenses: Record<string, number> = {};
    const monthlyIncome: Record<string, number> = {};
    for (const m of months) {
      monthlyIncome[m] = sumMoney(incomeSections.map((s) => s.subtotals[m] || 0));
      monthlyExpenses[m] = sumMoney(
        expenseSections.map((s) => s.subtotals[m] || 0),
      );
    }
    const totalIncomeSum = sumMoney(incomeSections.map((s) => s.subtotalSum));
    const totalExpensesSum = sumMoney(expenseSections.map((s) => s.subtotalSum));
    const totalExpensesAvg = roundMoney(totalExpensesSum / monthCount);
    const totalIncomeAvg = roundMoney(totalIncomeSum / monthCount);
    const monthlyBalance: Record<string, number> = {};
    for (const m of months) {
      monthlyBalance[m] = roundMoney(
        (monthlyIncome[m] || 0) - (monthlyExpenses[m] || 0),
      );
    }
    const balanceSum = roundMoney(totalIncomeSum - totalExpensesSum);
    const balanceAvg = roundMoney(balanceSum / monthCount);

    return {
      months,
      sections,
      incomeSections,
      expenseSections,
      monthlyExpenses,
      monthlyIncome,
      totalExpensesSum,
      totalIncomeSum,
      totalExpensesAvg,
      totalIncomeAvg,
      monthlyBalance,
      balanceSum,
      balanceAvg,
    };
  }, [data, otherExpensesLabel, otherIncomeLabel]);

  const lastDayOfMonth = (month: string): string => {
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    return `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  };

  const navigateToTransactions = (
    categoryIds: string[],
    start: string | undefined,
    end: string | undefined,
  ) => {
    const ids = Array.from(new Set(categoryIds));
    if (ids.length === 0) return;
    const params = new URLSearchParams({ categoryIds: ids.join(',') });
    if (start) params.set('startDate', start);
    if (end) params.set('endDate', end);
    router.push(`/transactions?${params.toString()}`);
  };

  // Drill into a single month for the given categories.
  const drillDown = (month: string, categoryIds: string[]) => {
    navigateToTransactions(categoryIds, `${month}-01`, lastDayOfMonth(month));
  };

  // Drill into the full report date range for the given categories (used when
  // clicking a category/subcategory name rather than a single month cell).
  const drillDownRange = (categoryIds: string[]) => {
    navigateToTransactions(categoryIds, rangeStart || undefined, rangeEnd || undefined);
  };

  // Export the breakdown as a CSV matrix: one row per category (with its parent
  // group), then the income/expense/balance summary rows. Amounts carry the same
  // sign convention as the table (expenses negative, income positive).
  const handleExportCsv = () => {
    if (!model) return;
    const signed = (isIncome: boolean, value: number) =>
      roundMoney(isIncome ? value : -value);
    const headers = [
      t('monthlyCategoryBreakdown.csvParentColumn'),
      t('monthlyCategoryBreakdown.category'),
      ...model.months.map((m) => formatMonth(m)),
      t('monthlyCategoryBreakdown.total'),
      t('monthlyCategoryBreakdown.avgPerMonth'),
    ];
    const rows: (string | number)[][] = [];
    for (const section of model.sections) {
      for (const row of section.rows) {
        rows.push([
          section.title,
          row.displayName,
          ...model.months.map((m) => signed(row.isIncome, row.values[m] || 0)),
          signed(row.isIncome, row.total),
          signed(row.isIncome, row.avg),
        ]);
      }
    }
    rows.push([
      '',
      t('monthlyCategoryBreakdown.totalExpenses'),
      ...model.months.map((m) => roundMoney(-(model.monthlyExpenses[m] || 0))),
      roundMoney(-model.totalExpensesSum),
      roundMoney(-model.totalExpensesAvg),
    ]);
    rows.push([
      '',
      t('monthlyCategoryBreakdown.totalIncome'),
      ...model.months.map((m) => roundMoney(model.monthlyIncome[m] || 0)),
      roundMoney(model.totalIncomeSum),
      roundMoney(model.totalIncomeAvg),
    ]);
    rows.push([
      '',
      t('monthlyCategoryBreakdown.balance'),
      ...model.months.map((m) => model.monthlyBalance[m] || 0),
      model.balanceSum,
      model.balanceAvg,
    ]);
    exportToCsv('monthly-category-breakdown', headers, rows);
  };

  // Render a single signed amount cell value (or a percentage in percent mode).
  const formatCell = (
    value: number,
    monthTotal: number,
    isIncome: boolean | null,
  ): string => {
    if (value === 0) return '—';
    const normalized = isIncome === null ? value : isIncome ? value : -value;
    const sign = normalized > 0 ? '+' : '-';
    if (showPercentages && monthTotal > 0) {
      const pct = (Math.abs(normalized) / monthTotal) * 100;
      return `${sign}${pct.toFixed(1)}%`;
    }
    return `${sign} ${formatCurrency(Math.abs(normalized), currency)}`;
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const months = model?.months ?? [];
  const hasData = model != null && model.sections.length > 0 && months.length > 0;
  const colSpan = months.length + 3;

  // Render one parent section: its colored header, the alphabetically sorted
  // subcategory rows, and the section subtotal.
  const renderSection = (section: Section, si: number) => {
    const sectionMonthTotal = (m: string) =>
      section.isIncome ? model!.monthlyIncome[m] : model!.monthlyExpenses[m];
    const sectionSum = section.isIncome
      ? model!.totalIncomeSum
      : model!.totalExpensesSum;
    const sectionAvg = section.isIncome
      ? model!.totalIncomeAvg
      : model!.totalExpensesAvg;
    return (
      <Fragment key={`section-${si}`}>
        {/* Section header. The colored bar spans the full table width while
            the label is pinned to the left so it stays visible when the table
            is scrolled horizontally. */}
        <tr>
          <td colSpan={colSpan} className={`p-0 font-semibold ${section.paletteClass}`}>
            <div className="sticky left-0 z-10 px-2 py-1.5 inline-block max-w-full">
              {section.allCategoryIds.length > 0 ? (
                <button
                  type="button"
                  onClick={() => drillDownRange(section.allCategoryIds)}
                  className="text-left hover:underline"
                >
                  {section.title}
                </button>
              ) : (
                section.title
              )}
            </div>
          </td>
        </tr>
        {/* Subcategory rows (sorted alphabetically) */}
        {section.rows.map((row) => (
          <tr key={row.categoryId || row.displayName} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
            <td
              className="sticky left-0 z-10 bg-white dark:bg-gray-800 pl-5 pr-2 py-1 text-gray-900 dark:text-gray-100 truncate max-w-[220px]"
              title={row.displayName}
            >
              {row.categoryId ? (
                <button
                  type="button"
                  onClick={() => drillDownRange([row.categoryId!])}
                  className="block w-full text-left truncate hover:underline"
                >
                  {row.displayName}
                </button>
              ) : (
                row.displayName
              )}
            </td>
            {months.map((m) => {
              const value = row.values[m] || 0;
              const cls = deviationClass(value, row.nonZeroAvg, row.nonZeroCount, row.isIncome);
              return (
                <td key={m} className={`px-2 py-1 text-right ${cls}`}>
                  {value !== 0 && row.categoryId ? (
                    <button
                      type="button"
                      onClick={() => drillDown(m, [row.categoryId!])}
                      className="hover:underline"
                    >
                      {formatCell(value, sectionMonthTotal(m), row.isIncome)}
                    </button>
                  ) : value !== 0 ? (
                    formatCell(value, sectionMonthTotal(m), row.isIncome)
                  ) : (
                    <span className="text-gray-300 dark:text-gray-600">—</span>
                  )}
                </td>
              );
            })}
            <td className="px-2 py-1 text-right font-semibold text-gray-900 dark:text-gray-100">
              {formatCell(row.total, sectionSum, row.isIncome)}
            </td>
            <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300">
              {formatCell(row.avg, sectionAvg, row.isIncome)}
            </td>
          </tr>
        ))}
        {/* Section subtotal */}
        <tr className="font-bold bg-gray-50 dark:bg-gray-900 border-t-2 border-gray-300 dark:border-gray-600">
          <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-900 px-2 py-1 truncate" title={`${t('monthlyCategoryBreakdown.subtotal')}: ${section.title}`}>
            {t('monthlyCategoryBreakdown.subtotal')}: {section.title}
          </td>
          {months.map((m) => {
            const value = section.subtotals[m] || 0;
            return (
              <td key={m} className="px-2 py-1 text-right">
                {value !== 0 ? (
                  <button
                    type="button"
                    onClick={() => drillDown(m, section.allCategoryIds)}
                    className="hover:underline"
                  >
                    {formatCell(value, sectionMonthTotal(m), section.isIncome)}
                  </button>
                ) : (
                  <span className="text-gray-300 dark:text-gray-600">—</span>
                )}
              </td>
            );
          })}
          <td className="px-2 py-1 text-right">
            {formatCell(section.subtotalSum, sectionSum, section.isIncome)}
          </td>
          <td className="px-2 py-1 text-right">
            {formatCell(section.subtotalAvg, sectionAvg, section.isIncome)}
          </td>
        </tr>
      </Fragment>
    );
  };

  // The bold per-month total for a whole income or expense group, shown at the
  // bottom of that group.
  const renderGroupTotal = (isIncome: boolean) => {
    const label = isIncome
      ? t('monthlyCategoryBreakdown.totalIncome')
      : t('monthlyCategoryBreakdown.totalExpenses');
    const monthly = isIncome ? model!.monthlyIncome : model!.monthlyExpenses;
    const sum = isIncome ? model!.totalIncomeSum : model!.totalExpensesSum;
    const avg = isIncome ? model!.totalIncomeAvg : model!.totalExpensesAvg;
    const accent = isIncome
      ? 'text-green-700 dark:text-green-300'
      : 'text-red-700 dark:text-red-300';
    return (
      <tr className="font-bold bg-gray-100 dark:bg-gray-900 border-t-2 border-gray-400 dark:border-gray-500">
        <td className={`sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 px-2 py-1 ${accent}`}>
          {label}
        </td>
        {months.map((m) => (
          <td key={m} className={`px-2 py-1 text-right ${accent}`}>
            {formatGrand(monthly[m] || 0, isIncome, formatCurrency, currency)}
          </td>
        ))}
        <td className={`px-2 py-1 text-right ${accent}`}>
          {formatGrand(sum, isIncome, formatCurrency, currency)}
        </td>
        <td className={`px-2 py-1 text-right ${accent}`}>
          {formatGrand(avg, isIncome, formatCurrency, currency)}
        </td>
      </tr>
    );
  };

  // Full-width group header bar ("Income" / "Expenses").
  const renderGroupHeader = (isIncome: boolean) => (
    <tr>
      <td
        colSpan={colSpan}
        className={`px-2 py-1.5 font-bold text-sm ${isIncome ? INCOME_GROUP_CLASS : EXPENSE_GROUP_CLASS}`}
      >
        <div className="sticky left-0 z-10 inline-block">
          {isIncome
            ? t('monthlyCategoryBreakdown.income')
            : t('monthlyCategoryBreakdown.expenses')}
        </div>
      </td>
    </tr>
  );

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['3m', '6m', '1y', 'ytd']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <ToggleSwitch
                checked={showPercentages}
                onChange={setShowPercentages}
                label={t('monthlyCategoryBreakdown.showPercentages')}
                size="sm"
              />
              <span>{t('monthlyCategoryBreakdown.showPercentages')}</span>
            </div>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!hasData}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {t('monthlyCategoryBreakdown.exportCsv')}
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {!hasData ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('monthlyCategoryBreakdown.noData')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 dark:text-gray-400">
                  <th className="sticky left-0 z-10 bg-white dark:bg-gray-800 px-2 py-2 text-left font-medium min-w-[180px]">
                    {t('monthlyCategoryBreakdown.category')}
                  </th>
                  {months.map((m) => (
                    <th key={m} className="px-2 py-2 text-right font-medium whitespace-nowrap">
                      {formatMonth(m)}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-medium">
                    {t('monthlyCategoryBreakdown.total')}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t('monthlyCategoryBreakdown.avgPerMonth')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* Income group: sections (alphabetical) then the income total */}
                {model!.incomeSections.length > 0 && (
                  <Fragment>
                    {renderGroupHeader(true)}
                    {model!.incomeSections.map((section, si) =>
                      renderSection(section, si),
                    )}
                    {renderGroupTotal(true)}
                  </Fragment>
                )}

                {/* Expense group: sections (alphabetical) then the expense total */}
                {model!.expenseSections.length > 0 && (
                  <Fragment>
                    {renderGroupHeader(false)}
                    {model!.expenseSections.map((section, si) =>
                      renderSection(section, model!.incomeSections.length + si),
                    )}
                    {renderGroupTotal(false)}
                  </Fragment>
                )}

                {/* Summary: the net balance (income minus expenses) */}
                <tr>
                  <td colSpan={colSpan} className="px-2 py-1.5 font-semibold bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100">
                    {t('monthlyCategoryBreakdown.summary')}
                  </td>
                </tr>
                <tr className="font-bold bg-gray-100 dark:bg-gray-900 border-t-2 border-gray-400 dark:border-gray-500">
                  <td className="sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 px-2 py-1">
                    {t('monthlyCategoryBreakdown.balance')}
                  </td>
                  {months.map((m) => {
                    const bal = model!.monthlyBalance[m] || 0;
                    return (
                      <td key={m} className={`px-2 py-1 text-right ${bal >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {formatGrand(bal, null, formatCurrency, currency)}
                      </td>
                    );
                  })}
                  <td className={`px-2 py-1 text-right ${model!.balanceSum >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {formatGrand(model!.balanceSum, null, formatCurrency, currency)}
                  </td>
                  <td className={`px-2 py-1 text-right ${model!.balanceAvg >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {formatGrand(model!.balanceAvg, null, formatCurrency, currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Grand-summary cell formatter. `isIncome` of null renders the raw signed
 * value (used by the balance row); true/false force the sign for income or
 * expense rows respectively.
 */
function formatGrand(
  value: number,
  isIncome: boolean | null,
  formatCurrency: (amount: number, currencyCode?: string) => string,
  currency: string | undefined,
): string {
  if (value === 0) return '—';
  const normalized = isIncome === null ? value : isIncome ? value : -value;
  const sign = normalized > 0 ? '+' : '-';
  return `${sign} ${formatCurrency(Math.abs(normalized), currency)}`;
}
