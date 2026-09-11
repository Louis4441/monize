'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TopMover } from '@/types/investment';
import { WidgetHeading } from './widget-meta';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { CARD_CLASS } from '@/components/ui/Card';
import { preferredCurrency } from '@/lib/default-currency';

type MoverFilter = 'all' | 'gainers' | 'losers';
/** Whether a "biggest" mover is the largest move in money or in percent. */
type MoverMetric = 'amount' | 'percent';

const FILTER_STORAGE_KEY = 'dashboard.topMovers.filter';
const METRIC_STORAGE_KEY = 'dashboard.topMovers.metric';

/** Read a stored choice, falling back to `fallback` for anything unrecognised. */
function readStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = localStorage.getItem(key);
    return allowed.includes(stored as T) ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Persist a choice. Best-effort: blocked or full storage is not an error here. */
function writeStoredChoice(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures (e.g. disabled/blocked storage).
  }
}

const MOVER_FILTERS = ['all', 'gainers', 'losers'] as const;
const MOVER_METRICS = ['amount', 'percent'] as const;

/**
 * Rank movers for a filter and a metric, and take the top five.
 *
 * The two questions are separate: the filter says which direction counts, the
 * metric says what "biggest" measures. A holding worth thousands moves the most
 * money on a small percentage, and a small holding moves the most percent on
 * very little -- so the widget ranks by whichever the user asked about rather
 * than reporting one under the other's heading.
 *
 * The server pre-sorts by absolute daily change in money, which is exactly the
 * all + amount answer; every other combination is re-sorted here.
 */
export function rankMovers(
  movers: TopMover[],
  filter: MoverFilter,
  metric: MoverMetric,
  limit = 5,
): TopMover[] {
  const magnitude = (m: TopMover) =>
    metric === 'amount' ? m.dailyChange : m.dailyChangePercent;
  if (filter === 'gainers') {
    return movers
      .filter((m) => m.dailyChange > 0)
      .sort((a, b) => magnitude(b) - magnitude(a))
      .slice(0, limit);
  }
  if (filter === 'losers') {
    return movers
      .filter((m) => m.dailyChange < 0)
      .sort((a, b) => magnitude(a) - magnitude(b))
      .slice(0, limit);
  }
  if (metric === 'amount') return movers.slice(0, limit);
  return [...movers]
    .sort((a, b) => Math.abs(magnitude(b)) - Math.abs(magnitude(a)))
    .slice(0, limit);
}

interface TopMoversProps {
  movers: TopMover[];
  isLoading: boolean;
  hasInvestmentAccounts: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

/** A segmented button group of mutually exclusive choices. */
function MoverSegmentedControl<T extends string>({
  value,
  options,
  groupLabel,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  groupLabel: string;
  onChange: (value: T) => void;
}) {
  const rounding = (index: number) =>
    index === 0
      ? 'rounded-l-md border'
      : index === options.length - 1
        ? 'rounded-r-md border'
        : 'border-t border-b';
  return (
    <div className="inline-flex rounded-md shadow-sm" role="group" aria-label={groupLabel}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 text-sm font-medium ${rounding(index)} ${
            value === option.value
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RefreshButton({ onRefresh, isRefreshing, refreshTitle }: { onRefresh?: () => void; isRefreshing?: boolean; refreshTitle: string }) {
  if (!onRefresh) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onRefresh(); }}
      disabled={isRefreshing}
      className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
      title={refreshTitle}
    >
      <svg
        className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
    </button>
  );
}

export function TopMovers({ movers, isLoading, hasInvestmentAccounts, onRefresh, isRefreshing }: TopMoversProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyPrecise, formatPercent } = useNumberFormat();
  const defaultCurrency = preferredCurrency(
    usePreferencesStore((s) => s.preferences?.defaultCurrency),
  );
  const [filter, setFilter] = useState<MoverFilter>(() =>
    readStoredChoice(FILTER_STORAGE_KEY, MOVER_FILTERS, 'all'),
  );
  const [metric, setMetric] = useState<MoverMetric>(() =>
    readStoredChoice(METRIC_STORAGE_KEY, MOVER_METRICS, 'amount'),
  );

  useEffect(() => {
    writeStoredChoice(FILTER_STORAGE_KEY, filter);
  }, [filter]);

  useEffect(() => {
    writeStoredChoice(METRIC_STORAGE_KEY, metric);
  }, [metric]);

  const filterOptions: { value: MoverFilter; label: string }[] = [
    { value: 'all', label: t('topMovers.filter.all') },
    { value: 'gainers', label: t('topMovers.filter.gainers') },
    { value: 'losers', label: t('topMovers.filter.losers') },
  ];
  const metricOptions: { value: MoverMetric; label: string }[] = [
    { value: 'amount', label: t('topMovers.metric.amount') },
    { value: 'percent', label: t('topMovers.metric.percent') },
  ];

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
        <div className="flex items-center justify-between mb-4">
          <WidgetHeading id="top-movers" href="/investments">
            {t('topMovers.title')}
          </WidgetHeading>
          <div className="flex items-center gap-2">
            <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('topMovers.refreshPrices')} />
            <span className="text-sm text-gray-500 dark:text-gray-400">{t('topMovers.dailyChange')}</span>
          </div>
        </div>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (movers.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
        <div className="flex items-center justify-between mb-4">
          <WidgetHeading id="top-movers" href="/investments">
            {t('topMovers.title')}
          </WidgetHeading>
          <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('topMovers.refreshPrices')} />
        </div>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {hasInvestmentAccounts
            ? t('topMovers.empty.noPrices')
            : t('topMovers.empty.noInvestments')}
        </p>
      </div>
    );
  }

  const topMovers = rankMovers(movers, filter, metric);

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
      <div className="flex items-center justify-between mb-4">
        <WidgetHeading id="top-movers" href="/investments">
          {t('topMovers.title')}
        </WidgetHeading>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('topMovers.refreshPrices')} />
          <span className="text-sm text-gray-500 dark:text-gray-400">{t('topMovers.dailyChange')}</span>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MoverSegmentedControl
          value={filter}
          options={filterOptions}
          groupLabel={t('topMovers.filter.label')}
          onChange={setFilter}
        />
        <MoverSegmentedControl
          value={metric}
          options={metricOptions}
          groupLabel={t('topMovers.metric.label')}
          onChange={setMetric}
        />
      </div>
      {topMovers.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {filter === 'gainers' ? t('topMovers.empty.noGainers') : t('topMovers.empty.noLosers')}
        </p>
      ) : (
      <div className="space-y-2 sm:space-y-3">
        {topMovers.map((mover) => {
          const isPositive = mover.dailyChange >= 0;
          const isForeign = mover.currencyCode && mover.currencyCode !== defaultCurrency;
          const fmtPrice = (value: number) => {
            const formatted = formatCurrencyPrecise(value, mover.currencyCode);
            return isForeign ? `${formatted} ${mover.currencyCode}` : formatted;
          };
          return (
            <button
              key={mover.securityId}
              type="button"
              onClick={() => router.push(`/securities/${mover.securityId}?tab=prices`)}
              title={t('topMovers.openPriceHistory', { symbol: mover.symbol })}
              className="flex w-full items-center justify-between p-2 sm:p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-left transition-colors hover:border-blue-400 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:border-blue-500 dark:hover:bg-gray-700/50"
            >
              <div className="min-w-0">
                {/* The row's content is its accessible name -- symbol, name,
                    price and change -- so the action is added as screen-reader
                    text rather than an aria-label that would replace all of
                    it. */}
                <span className="sr-only">
                  {t('topMovers.openPriceHistory', { symbol: mover.symbol })}
                </span>
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {mover.symbol}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {mover.name}
                </div>
              </div>
              <div className="text-right flex-shrink-0 ml-3">
                <div className="text-sm text-gray-600 dark:text-gray-300">
                  {fmtPrice(mover.currentPrice)}
                </div>
                <div
                  className={`text-sm font-medium ${
                    isPositive
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {isPositive ? '+' : ''}{formatCurrencyPrecise(mover.dailyChange, mover.currencyCode)} ({isPositive ? '+' : ''}{formatPercent(mover.dailyChangePercent)})
                </div>
              </div>
            </button>
          );
        })}
      </div>
      )}
      <button
        onClick={() => router.push('/investments')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        {t('topMovers.viewPortfolio')}
      </button>
    </div>
  );
}
