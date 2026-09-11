'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { chartColors } from '@/lib/chart-colors';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { transactionsApi } from '@/lib/transactions';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { DonutCenterTotal } from '@/components/ui/DonutCenterTotal';
import { ChartLegend } from '@/components/ui/ChartLegend';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import {
  EXPENSES_PIE_DEFAULT,
  SPENDING_RANGES,
  ExpensesPieConfig,
} from './widget-config';

const WIDGET_ID = 'expenses-pie';
/** How many categories keep a slice of their own before the rest become Other. */
const MAX_SLICES = 11;

/**
 * The top-level ancestor of a category, walking `parentId` up the tree.
 *
 * Returns the id itself for a category that is already top-level or whose
 * parent is not in the list. The walk is bounded by the number of categories,
 * so a cycle written by a bad import cannot hang the dashboard.
 */
function topLevelCategoryId(
  categoryId: string,
  byId: Map<string, Category>,
): string {
  let current = byId.get(categoryId);
  let steps = byId.size;
  while (current?.parentId && steps-- > 0) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? categoryId;
}

const nonInvestmentAccounts = (a: Account) => a.accountType !== 'INVESTMENT';

interface ExpensesPieChartProps {
  accounts: Account[];
  categories: Category[];
  isLoading: boolean;
}

export function ExpensesPieChart({
  accounts,
  categories,
  isLoading,
}: ExpensesPieChartProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatPercent } = useNumberFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const { config, updateConfig } = useWidgetConfig<ExpensesPieConfig>(
    WIDGET_ID,
    EXPENSES_PIE_DEFAULT,
  );
  // Whether the Other slice is opened into the categories inside it. A view
  // state, not a setting: it belongs to this glance at the chart, so it is not
  // persisted and it closes whenever the data behind it changes.
  const [otherExpanded, setOtherExpanded] = useState(false);

  const { start, end } = useMemo(() => resolveRangePreset(config.range), [config.range]);
  const accountIdsKey = config.accountIds.join(',');

  const { data: transactions, isLoading: dataLoading } = useReportData(
    () =>
      transactionsApi.getAllPages({
        startDate: start || undefined,
        endDate: end,
        accountIds: config.accountIds.length > 0 ? config.accountIds : undefined,
      }),
    [start, end, accountIdsKey],
  );

  // Calculate spending by category
  const breakdown = useMemo(() => {
    const categoryMap = new Map<string, { id: string; name: string; value: number; colour: string }>();
    // Currencies left out of the breakdown for want of a rate, so the chart can
    // say the slices do not add up to everything spent, and how many individual
    // amounts (a component count) were dropped.
    const missingCurrencies = new Set<string>();
    let excludedCount = 0;
    let uncategorizedTotal = 0;

    // Build category lookup
    const categoryLookup = new Map(categories.map((c) => [c.id, c]));

    // Which category a spend is filed under. With the rollup on, a subcategory
    // counts against its top-level ancestor, so the chart answers "which part
    // of my budget" rather than listing every leaf. The transactions list
    // expands a category filter to its descendants, so a rolled-up slice still
    // opens every transaction behind it.
    const bucketFor = (
      categoryId: string,
      fallback: Category,
    ): { id: string; category: Category } => {
      if (!config.topLevelOnly) {
        return { id: categoryId, category: categoryLookup.get(categoryId) ?? fallback };
      }
      const rootId = topLevelCategoryId(categoryId, categoryLookup);
      return { id: rootId, category: categoryLookup.get(rootId) ?? fallback };
    };

    (transactions ?? []).forEach((tx) => {
      // Skip transfers and investment account transactions
      if (tx.isTransfer) return;
      if (tx.account?.accountType === 'INVESTMENT') return;

      // Spend is netted per category: a credit filed against an expense
      // category (a refund, a return) reduces what was spent there rather than
      // being skipped, so both signs are read and negated. Categories that end
      // up net-credit are dropped below, which is what keeps income out.
      const txAmount = Number(tx.amount) || 0;
      if (txAmount === 0) return;
      const convertedTx = convertToDefault(txAmount, tx.currencyCode);
      // No rate, no slice. A pie slice cannot say "unknown", and counting the
      // unconverted figure would size it in the wrong currency. Only a
      // transaction that could land in the expense breakdown makes the total
      // partial: a non-split income-category transaction is dropped by the
      // net-credit filter regardless, so naming its currency here would warn
      // about a currency that has no expenses.
      if (convertedTx === null) {
        // A transaction that would not land in the expense breakdown even with a
        // rate does not make the expense total partial. Only a *positive* amount
        // on an income category, or an uncategorized positive one, nets credit and
        // is dropped regardless; a negative amount (a clawback of income) can
        // become an expense slice, so it still counts as excluded. This is a
        // per-transaction heuristic and cannot see the category-level net, so it
        // errs toward marking partial rather than hiding a real gap -- the safe
        // direction under "a subtotal is not a total".
        const uncategorized = !tx.categoryId || !tx.category;
        const incomeOnly =
          !tx.isSplit &&
          txAmount > 0 &&
          (tx.category?.isIncome === true || uncategorized);
        if (!incomeOnly) {
          missingCurrencies.add(tx.currencyCode);
          excludedCount += 1;
        }
        return;
      }
      const expenseAmount = -convertedTx;

      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        // Handle split transactions
        tx.splits.forEach((split) => {
          const splitAmt = Number(split.amount) || 0;
          if (splitAmt === 0) return;
          // Splits carry the transaction's currency, which the whole-amount
          // conversion above already resolved, so this null branch is a defensive
          // guard rather than a reachable exclusion -- the missing rate is caught
          // once at the transaction level, not per split.
          const convertedSplit = convertToDefault(splitAmt, tx.currencyCode);
          if (convertedSplit === null) {
            missingCurrencies.add(tx.currencyCode);
            excludedCount += 1;
            return;
          }
          const splitAmount = -convertedSplit;
          if (split.categoryId && split.category) {
            const { id, category: cat } = bucketFor(split.categoryId, split.category);
            const existing = categoryMap.get(id);
            if (existing) {
              existing.value += splitAmount;
            } else {
              categoryMap.set(id, {
                id,
                name: cat.name,
                value: splitAmount,
                colour: cat.effectiveColor ?? cat.color ?? '',
              });
            }
          } else if (!split.transferAccountId) {
            uncategorizedTotal += splitAmount;
          }
        });
      } else if (tx.categoryId && tx.category) {
        // Regular transaction with category
        const { id, category: cat } = bucketFor(tx.categoryId, tx.category);
        const existing = categoryMap.get(id);
        if (existing) {
          existing.value += expenseAmount;
        } else {
          categoryMap.set(id, {
            id,
            name: cat.name,
            value: expenseAmount,
            colour: cat.effectiveColor ?? cat.color ?? '',
          });
        }
      } else {
        // Uncategorized
        uncategorizedTotal += expenseAmount;
      }
    });

    // Add uncategorized if any
    if (uncategorizedTotal > 0) {
      categoryMap.set('uncategorized', {
        id: '',
        name: t('expensesPieChart.uncategorized'),
        value: uncategorizedTotal,
        colour: chartColors.neutral,
      });
    }

    // Convert to array and sort by value descending. A category whose credits
    // met or exceeded its debits over the range was not spent in, so it is not
    // a slice -- and neither is an income category, which nets negative.
    const sorted = Array.from(categoryMap.values())
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value);

    const top = sorted.slice(0, MAX_SLICES);
    const inOther = sorted.slice(MAX_SLICES);
    const otherTotal = inOther.reduce((sum, item) => sum + item.value, 0);
    const data =
      inOther.length > 0
        ? [
            ...top,
            {
              id: '',
              name: t('expensesPieChart.other'),
              value: otherTotal,
              colour: chartColors.neutral,
            },
          ]
        : top;

    // Assign colours to categories without one
    let colourIndex = 0;
    [...data, ...inOther].forEach((item) => {
      if (!item.colour) {
        item.colour = CHART_COLOURS[colourIndex % CHART_COLOURS.length];
        colourIndex++;
      }
    });

    return { data, inOther, missingCurrencies: [...missingCurrencies], excludedCount };
  }, [transactions, categories, convertToDefault, config.topLevelOnly, t]);

  const chartData = breakdown.data;
  const totalExpenses = chartData.reduce((sum, item) => sum + item.value, 0);
  // The categories merged into Other, listed only while the user has opened it.
  const otherCategories = breakdown.inOther;
  // Close the disclosure when the categories inside Other are no longer the ones
  // the user opened -- a different timeframe, account filter or rollup answers a
  // different question. Keyed on the identities themselves rather than on the
  // memo's object, which is a fresh reference whenever its inputs re-resolve.
  // The "info from a previous render" pattern, not a setState in an effect.
  const otherKey = otherCategories.map((item) => item.id || item.name).join('|');
  const [openedFor, setOpenedFor] = useState(otherKey);
  if (openedFor !== otherKey) {
    setOpenedFor(otherKey);
    if (otherExpanded) setOtherExpanded(false);
  }

  const handleCategoryClick = (categoryId: string) => {
    if (categoryId) {
      const params = new URLSearchParams({ categoryIds: categoryId });
      if (start) params.set('startDate', start);
      params.set('endDate', end);
      router.push(`/transactions?${params.toString()}`);
    }
  };

  // A slice with an id opens its transactions; Other has none, and opens into
  // the categories it merged instead of going nowhere.
  const handleSliceClick = (categoryId: string) => {
    if (categoryId) return handleCategoryClick(categoryId);
    if (otherCategories.length > 0) setOtherExpanded((open) => !open);
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { id: string; name: string; value: number; colour: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const percentage = (data.value / totalExpenses) * 100;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
          <p className="text-gray-600 dark:text-gray-400">
            {formatCurrency(data.value)} ({formatPercent(percentage, 1)})
          </p>
        </div>
      );
    }
    return null;
  };

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={SPENDING_RANGES}
          value={config.range}
          onChange={(range) => updateConfig({ range })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={accounts}
          value={config.accountIds}
          onChange={(accountIds) => updateConfig({ accountIds })}
          filter={nonInvestmentAccounts}
          className="w-full"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('expensesPieChart.topLevelOnly')}>
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={config.topLevelOnly}
            onChange={(topLevelOnly) => updateConfig({ topLevelOnly })}
            label={t('expensesPieChart.topLevelOnly')}
          />
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {t('expensesPieChart.topLevelOnlyHint')}
          </span>
        </div>
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('expensesPieChart.title')}
      titleHref="/reports/spending-by-category"
      widgetId={WIDGET_ID}
      configTitle={t('expensesPieChart.title')}
      configControls={configControls}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
        </span>
      }
    >
      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('expensesPieChart.empty')}</WidgetMessage>
      ) : (
        <>
          <div className="relative h-64">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  cursor="pointer"
                  onClick={(data) => handleSliceClick(String(data.id ?? ''))}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.colour} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            {/* The aggregate belongs in the donut's hole, not in a row beneath
                the legend that a phone has to scroll to. */}
            <DonutCenterTotal
              label={t('expensesPieChart.total')}
              value={
                <PartialTotal
                  total={{
                    value: totalExpenses,
                    missingCurrencies: breakdown.missingCurrencies,
                    excludedCount: breakdown.excludedCount,
                  }}
                  displayCurrency={defaultCurrency}
                >
                  {formatCurrency(totalExpenses)}
                </PartialTotal>
              }
            />
          </div>
          {/* One vertical column on a phone, three from `sm` up -- the desktop
              density this legend carried before the mobile-first redesign. */}
          <ChartLegend
            className="mt-4"
            columnsClassName="sm:grid-cols-3"
            items={chartData.map((item, index) => ({
              key: String(index),
              name: item.name,
              color: item.colour,
              onClick: () => handleSliceClick(item.id),
              // Other is only inert while it merged nothing; with categories
              // inside it, it opens them.
              disabled: !item.id && otherCategories.length === 0,
            }))}
          />
          {otherExpanded && otherCategories.length > 0 && (
            // What Other merged, at the same precision as the slices above it.
            // The chart keeps eleven slices whatever happens here: turning a
            // long tail into twenty slivers would make the chart unreadable and
            // answer a different question from the one the user asked.
            <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                {t('expensesPieChart.insideOther', { count: otherCategories.length })}
              </p>
              <ul className="space-y-1">
                {otherCategories.map((item) => (
                  <li key={item.id || item.name}>
                    <button
                      type="button"
                      onClick={() => handleCategoryClick(item.id)}
                      disabled={!item.id}
                      className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                        style={{ backgroundColor: item.colour }}
                      />
                      <span className="truncate text-gray-600 dark:text-gray-300">
                        {item.name}
                      </span>
                      <span className="ml-auto flex-shrink-0 text-gray-900 dark:text-gray-100">
                        {formatCurrency(item.value)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </WidgetCard>
  );
}
