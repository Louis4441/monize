'use client';

import React, { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummary } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { gainLossColor } from '@/lib/format';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SecurityComparisonChart } from '@/components/reports/SecurityComparisonChart';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { useDateRange } from '@/hooks/useDateRange';
import { CHART_RANGES } from '@/lib/security-detail';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import {
  CAPTION_CLASS,
  CellLabel,
  PHONE_HEADER_CLASS,
  type SortColumn,
  type SortColumnsByField,
} from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import { aggregateHoldingsBySecurity, AggregatedHolding } from '@/lib/aggregate-holdings';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';

type HoldingsSortField = 'symbol' | 'quantity' | 'averageCost' | 'currentPrice' | 'marketValue' | 'gainLoss' | 'gainLossPercent';

const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';
const CHILD_FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-2 sm:text-sm';

const CELL_PLACEMENT: Record<HoldingsSortField, string> = {
  symbol: 'col-start-1 row-start-1',
  quantity: 'col-start-1 row-start-2',
  averageCost: 'col-start-2 row-start-2',
  currentPrice: 'col-start-1 row-start-3',
  marketValue: 'col-start-2 row-start-1',
  gainLoss: 'col-start-2 row-start-3',
  gainLossPercent: 'col-start-1 col-span-2 row-start-4',
};

const ACCOUNTS_STORAGE_KEY = 'monize-reports-investment-performance-accounts';

export function InvestmentPerformanceReport() {
  const t = useTranslations('reports');
  const mainAccountName = useMainAccountName();
  const {
    formatCurrency: formatCurrencyFull,
    formatPercent: formatPlainPercent,
    formatShareQuantity,
    formatSignedPercent,
  } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  // Persisted so the report opens on the accounts the user last chose.
  // Accounts arrive with the data below, so stale IDs are pruned there.
  const [selectedAccountIds, setSelectedAccountIds, pruneAccountFilter] =
    usePersistedAccountFilter(ACCOUNTS_STORAGE_KEY);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedSecurityId, setExpandedSecurityId] = useState<string | null>(null);
  const [viewType, setViewType] = useState<'performance' | 'allocation'>('performance');
  // The historical performance chart's window, persisted like the other report
  // ranges. A price chart is measured over a period the user picks, so the
  // Performance view carries its own range selector; the Allocation view is a
  // point-in-time snapshot and has none.
  const { dateRange: perfRange, setDateRange: setPerfRange, resolvedRange: perfResolvedRange } =
    useDateRange({
      defaultRange: '1y',
      storageKey: 'reports.investment-performance.range',
    });
  const isSingleAccount = selectedAccountIds.length === 1;
  const { sortField, sortDirection, handleSort } = useSortableTable<HoldingsSortField>(
    'reports.investment-performance.holdings.sort',
    { field: 'marketValue', direction: 'desc' },
  );

  const columns: SortColumnsByField<
    HoldingsSortField,
    SortColumn<HoldingsSortField>
  > = {
    symbol: { field: 'symbol', label: t('investmentPerformance.colSecurity') },
    quantity: { field: 'quantity', label: t('investmentPerformance.colShares'), align: 'right' },
    averageCost: { field: 'averageCost', label: t('investmentPerformance.colAvgCost'), align: 'right' },
    currentPrice: { field: 'currentPrice', label: t('investmentPerformance.colCurrentPrice'), align: 'right' },
    marketValue: { field: 'marketValue', label: t('investmentPerformance.colMarketValue'), align: 'right' },
    gainLoss: { field: 'gainLoss', label: t('investmentPerformance.colGainLoss'), align: 'right' },
    gainLossPercent: { field: 'gainLossPercent', label: t('investmentPerformance.colReturn'), align: 'right' },
  };
  const sortColumns = Object.values(columns);

  const { data: response, isLoading, error, reload } = useReportData(
    async () => {
      const [portfolioData, accountsData] = await Promise.all([
        investmentsApi.getPortfolioSummary(selectedAccountIds.length > 0 ? selectedAccountIds : undefined),
        investmentsApi.getInvestmentAccounts(),
      ]);
      return { portfolio: portfolioData, accounts: accountsData };
    },
    [selectedAccountIds, reloadKey],
  );

  const portfolio = useMemo<PortfolioSummary | null>(
    () => response?.portfolio ?? null,
    [response],
  );
  const accounts = useMemo<Account[]>(() => response?.accounts ?? [], [response]);
  // Accounts load alongside the portfolio, so the persisted filter can only be
  // pruned of deleted accounts here, once the list is known.
  pruneAccountFilter(accounts);

  const formatPercent = (value: number) => formatSignedPercent(value);

  // When a single account is selected, show summary values in that account's native currency
  // (per-account totals are in native currency; top-level totals are converted to default)
  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const summaryCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeignSummary = summaryCurrency !== defaultCurrency;

  // Derive native-currency summary from holdingsByAccount when a single account is selected
  const summaryValues = useMemo(() => {
    if (!portfolio) return null;
    if (isSingleAccount && portfolio.holdingsByAccount.length > 0) {
      // Use per-account totals (native currency) instead of converted top-level totals
      let totalMarketValue = 0;
      let totalCashBalance = 0;
      let totalCostBasis = 0;
      for (const acct of portfolio.holdingsByAccount) {
        totalMarketValue += acct.totalMarketValue;
        totalCashBalance += acct.cashBalance;
        totalCostBasis += acct.totalCostBasis;
      }
      const totalPortfolioValue = totalMarketValue + totalCashBalance;
      const totalGainLoss = totalMarketValue - totalCostBasis;
      const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;
      return { totalPortfolioValue, totalCostBasis, totalGainLoss, totalGainLossPercent };
    }
    // All accounts: use the backend-converted totals (already in default currency)
    return {
      totalPortfolioValue: portfolio.totalPortfolioValue,
      totalCostBasis: portfolio.totalCostBasis,
      totalGainLoss: portfolio.totalGainLoss,
      totalGainLossPercent: portfolio.totalGainLossPercent,
    };
  }, [portfolio, isSingleAccount]);

  const fmtSummary = (value: number) => {
    if (isForeignSummary) {
      return `${formatCurrencyFull(value, summaryCurrency)} ${summaryCurrency}`;
    }
    return formatCurrencyFull(value);
  };

  const fmtHolding = (value: number | null, currencyCode: string) => {
    if (value === null) return t('investmentPerformance.na');
    if (currencyCode && currencyCode !== defaultCurrency) {
      return `${formatCurrencyFull(value, currencyCode)} ${currencyCode}`;
    }
    return formatCurrencyFull(value);
  };

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, mainAccountName(a.name)));
    return map;
  }, [accounts, mainAccountName]);

  const aggregatedHoldings = useMemo((): AggregatedHolding[] => {
    if (!portfolio) return [];
    const aggregated = aggregateHoldingsBySecurity(portfolio.holdings);
    aggregated.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'symbol':
          comparison = compareValues(a.symbol, b.symbol);
          break;
        case 'quantity':
          comparison = compareValues(a.quantity, b.quantity);
          break;
        case 'averageCost':
          comparison = compareValues(a.averageCost, b.averageCost);
          break;
        case 'currentPrice':
          comparison = compareValues(a.currentPrice, b.currentPrice);
          break;
        case 'marketValue':
          comparison = compareValues(a.marketValue, b.marketValue);
          break;
        case 'gainLoss':
          comparison = compareValues(a.gainLoss, b.gainLoss);
          break;
        case 'gainLossPercent':
          comparison = compareValues(a.gainLossPercent, b.gainLossPercent);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return aggregated;
  }, [portfolio, sortField, sortDirection]);

  const holdingsData = useMemo(() => {
    return aggregatedHoldings
      .filter((h) => h.marketValue && h.marketValue > 0)
      .map((h, index) => ({
        ...h,
        color: CHART_COLOURS[index % CHART_COLOURS.length],
      }));
  }, [aggregatedHoldings]);

  const allocationData = useMemo(() => {
    if (!portfolio) return [];
    return portfolio.allocation.map((item, index) => ({
      ...item,
      color: item.color || CHART_COLOURS[index % CHART_COLOURS.length],
    }));
  }, [portfolio]);

  // The securities to plot on the historical performance chart: every distinct
  // security the selected accounts currently hold. `getPortfolioSummary` is
  // already fetched with `selectedAccountIds`, so this list is the selected
  // scope's holdings -- the account filter reaches the chart through the data,
  // not through a second request key. Deduped so one security held in two
  // accounts is one line, not two identical ones.
  const performanceSecurityIds = useMemo(() => {
    if (!portfolio) return [];
    return [...new Set(portfolio.holdings.map((h) => h.securityId))];
  }, [portfolio]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');

    const cards = summaryValues ? [
      { label: t('investmentPerformance.totalValue'), value: fmtSummary(summaryValues.totalPortfolioValue), color: '#111827' },
      { label: t('investmentPerformance.costBasis'), value: fmtSummary(summaryValues.totalCostBasis), color: '#111827' },
      { label: t('investmentPerformance.totalGainLoss'), value: `${summaryValues.totalGainLoss >= 0 ? '+' : ''}${fmtSummary(summaryValues.totalGainLoss)}`, color: summaryValues.totalGainLoss >= 0 ? '#16a34a' : '#dc2626' },
      { label: t('investmentPerformance.return'), value: formatPercent(summaryValues.totalGainLossPercent), color: summaryValues.totalGainLossPercent >= 0 ? '#16a34a' : '#dc2626' },
    ] : undefined;

    const headers = [t('investmentPerformance.colSecurity'), t('investmentPerformance.colShares'), t('investmentPerformance.colAvgCost'), t('investmentPerformance.colCurrentPrice'), t('investmentPerformance.colMarketValue'), t('investmentPerformance.colGainLoss'), t('investmentPerformance.colReturn')];
    const rows = aggregatedHoldings.map((h) => [
      `${h.symbol} - ${h.name}`,
      formatShareQuantity(h.quantity),
      fmtHolding(h.averageCost, h.currencyCode),
      fmtHolding(h.currentPrice, h.currencyCode),
      fmtHolding(h.marketValue, h.currencyCode),
      fmtHolding(h.gainLoss, h.currencyCode),
      h.gainLossPercent !== null ? formatPercent(h.gainLossPercent) : 'N/A',
    ]);

    const legendItems = holdingsData.map((h) => ({
      color: h.color,
      label: `${h.symbol} - ${fmtHolding(h.marketValue, h.currencyCode)}`,
    }));

    await exportToPdf({
      title: t('investmentPerformance.pdfTitle'),
      summaryCards: cards,
      chartContainer: chartRef.current,
      chartLegend: legendItems.length > 0 ? legendItems : undefined,
      tableData: rows.length > 0 ? { headers, rows } : undefined,
      filename: 'investment-performance',
    });
  };

  const AllocationTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; value: number; percentage: number } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {formatCurrencyFull(data.value)} ({formatPlainPercent(data.percentage, 1)})
          </p>
        </div>
      );
    }
    return null;
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && response === null) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!portfolio || !summaryValues || portfolio.holdings.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('investmentPerformance.noHoldings')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Portfolio Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.totalValue')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtSummary(summaryValues.totalPortfolioValue)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.costBasis')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtSummary(summaryValues.totalCostBasis)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.totalGainLoss')}</div>
          <div className={`text-xl font-bold ${gainLossColor(summaryValues.totalGainLoss)}`}>
            {summaryValues.totalGainLoss >= 0 ? '+' : ''}{fmtSummary(summaryValues.totalGainLoss)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.return')}</div>
          <div className={`text-xl font-bold ${gainLossColor(summaryValues.totalGainLossPercent)}`}>
            {formatPercent(summaryValues.totalGainLossPercent)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />
          </div>
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setViewType('performance')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'performance'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('investmentPerformance.viewHoldings')}
            </button>
            <button
              onClick={() => setViewType('allocation')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'allocation'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('investmentPerformance.viewAllocation')}
            </button>
            <RefreshPricesButton onRefreshComplete={() => setReloadKey((k) => k + 1)} />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      <div ref={chartRef}>
      {viewType === 'performance' ? (
        <>
          {/* Historical performance: one cumulative-return line per held
              security over the selected window. Replaces the point-in-time
              holdings donut, which now lives under Allocation; the composition
              question and the "how have these performed" question are answered
              on their own tabs. The chart owns its own fetch, keyed on the held
              securities and the window, and renders the server's percent-return
              series with its null/exclusion handling intact. */}
          <div className="mb-6 flex justify-end">
            <DateRangeSelector
              ranges={CHART_RANGES}
              value={perfRange}
              onChange={setPerfRange}
              activeColour="bg-blue-600"
              size="sm"
            />
          </div>
          <SecurityComparisonChart
            securityIds={performanceSecurityIds}
            indexCodes={[]}
            startDate={perfResolvedRange.start}
            endDate={perfResolvedRange.end}
            reloadKey={reloadKey}
          />

          {/* Holdings Table */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('investmentPerformance.holdingsDetail')}
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                  <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                    {sortColumns.map((column) => (
                      <SortableHeader<HoldingsSortField>
                        key={column.field}
                        field={column.field}
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        className={PHONE_HEADER_CLASS}
                      >
                        {column.label}
                      </SortableHeader>
                    ))}
                  </tr>
                  <tr role="row" className="hidden sm:table-row">
                    {sortColumns.map((column) => (
                      <SortableHeader<HoldingsSortField>
                        key={column.field}
                        field={column.field}
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        align={column.align}
                        className={HEADER_CLASS}
                      >
                        {column.label}
                      </SortableHeader>
                    ))}
                  </tr>
                </thead>
                <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                  {aggregatedHoldings.map((holding) => {
                    const isExpandable = holding.accountBreakdowns.length > 1;
                    const isExpanded = expandedSecurityId === holding.securityId;
                    return (
                      <React.Fragment key={holding.securityId}>
                        <tr
                          role="row"
                          tabIndex={isExpandable ? 0 : undefined}
                          aria-expanded={isExpandable ? isExpanded : undefined}
                          className={`grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0 ${isExpandable ? `cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}` : ''}`}
                          onClick={isExpandable ? () => setExpandedSecurityId(isExpanded ? null : holding.securityId) : undefined}
                          onKeyDown={isExpandable ? activateOnKey(() => setExpandedSecurityId(isExpanded ? null : holding.securityId)) : undefined}
                        >
                          <td role="cell" className={`${CELL_PLACEMENT.symbol} min-w-0 p-0 sm:table-cell sm:px-4 sm:py-3`}>
                            <div className="flex items-center gap-2">
                              <div className="min-w-0">
                                <div className="font-medium text-gray-900 dark:text-gray-100">
                                  {holding.symbol}
                                </div>
                                <div className="break-words text-sm text-gray-500 dark:text-gray-400 sm:break-normal">
                                  {holding.name}
                                  {isExpandable && (
                                    <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                                      {t('investmentPerformance.accountCount', { count: holding.accountBreakdowns.length })}
                                    </span>
                                  )}
                                </div>
                              </div>
                              {isExpandable && (
                                <svg
                                  aria-hidden="true"
                                  className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                              )}
                            </div>
                          </td>
                          <td role="cell" className={`${CELL_PLACEMENT.quantity} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{columns.quantity.label}</CellLabel>
                            {formatShareQuantity(holding.quantity)}
                          </td>
                          <td role="cell" className={`${CELL_PLACEMENT.averageCost} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{columns.averageCost.label}</CellLabel>
                            {fmtHolding(holding.averageCost, holding.currencyCode)}
                          </td>
                          <td role="cell" className={`${CELL_PLACEMENT.currentPrice} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{columns.currentPrice.label}</CellLabel>
                            {fmtHolding(holding.currentPrice, holding.currencyCode)}
                          </td>
                          <td role="cell" className={`${CELL_PLACEMENT.marketValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{columns.marketValue.label}</CellLabel>
                            {fmtHolding(holding.marketValue, holding.currencyCode)}
                          </td>
                          <td role="cell" className={`${CELL_PLACEMENT.gainLoss} ${(holding.gainLoss || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'} ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{columns.gainLoss.label}</CellLabel>
                            {fmtHolding(holding.gainLoss, holding.currencyCode)}
                          </td>
                          <td role="cell" className={`${CELL_PLACEMENT.gainLossPercent} font-medium ${(holding.gainLossPercent || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'} ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{columns.gainLossPercent.label}</CellLabel>
                            {holding.gainLossPercent !== null ? formatPercent(holding.gainLossPercent) : t('investmentPerformance.na')}
                          </td>
                        </tr>
                        {isExpanded && holding.accountBreakdowns.map((sub) => (
                          <tr
                            key={sub.id}
                            role="row"
                            className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 bg-gray-50/70 px-4 py-2 dark:bg-gray-900/20 sm:table-row sm:p-0"
                          >
                            <td role="cell" className={`${CELL_PLACEMENT.symbol} min-w-0 p-0 text-sm text-gray-600 dark:text-gray-400 sm:table-cell sm:px-4 sm:py-2 sm:pl-10`}>
                              {accountNameById.get(sub.accountId) || t('investmentPerformance.unknownAccount')}
                            </td>
                            <td role="cell" className={`${CELL_PLACEMENT.quantity} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{columns.quantity.label}</CellLabel>
                              {formatShareQuantity(sub.quantity)}
                            </td>
                            <td role="cell" className={`${CELL_PLACEMENT.averageCost} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{columns.averageCost.label}</CellLabel>
                              {fmtHolding(sub.averageCost, sub.currencyCode)}
                            </td>
                            <td role="cell" className={`${CELL_PLACEMENT.currentPrice} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{columns.currentPrice.label}</CellLabel>
                              {fmtHolding(sub.currentPrice, sub.currencyCode)}
                            </td>
                            <td role="cell" className={`${CELL_PLACEMENT.marketValue} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{columns.marketValue.label}</CellLabel>
                              {fmtHolding(sub.marketValue, sub.currencyCode)}
                            </td>
                            <td role="cell" className={`${CELL_PLACEMENT.gainLoss} ${(sub.gainLoss || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'} ${CHILD_FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{columns.gainLoss.label}</CellLabel>
                              {fmtHolding(sub.gainLoss, sub.currencyCode)}
                            </td>
                            <td role="cell" className={`${CELL_PLACEMENT.gainLossPercent} ${(sub.gainLossPercent || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'} ${CHILD_FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{columns.gainLossPercent.label}</CellLabel>
                              {sub.gainLossPercent !== null ? formatPercent(sub.gainLossPercent) : t('investmentPerformance.na')}
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* Asset Allocation View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('investmentPerformance.assetAllocation')}
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    data={allocationData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={120}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                  >
                    {allocationData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<AllocationTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2">
              {allocationData.map((item, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: item.color }}
                    />
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {item.name}
                      </div>
                      {item.symbol && (
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {item.symbol}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrencyFull(item.value)}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {formatPlainPercent(item.percentage, 1)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
