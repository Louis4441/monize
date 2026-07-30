'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  computeSeasonality,
  MIN_YEARS_FOR_SEASONALITY,
} from '@/lib/payee-seasonality';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { MonthlyTotal } from '@/types/transaction';

interface PayeeSeasonalityPanelProps {
  /** The payee's whole monthly history. */
  monthly: MonthlyTotal[];
  currencyStrategy: DisplayCurrencyStrategy;
  isLoading: boolean;
}

/** All twelve calendar months, so a month with no history still gets a slot. */
const CALENDAR_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * When in the year this payee costs money: a typical January beside a typical
 * December, averaged over every year of history.
 *
 * Twelve fixed slots, always in calendar order, because the shape of the year is
 * the point -- sorting by size or dropping the quiet months would destroy it. A
 * month the payee has never been billed in is drawn as an empty slot rather than
 * omitted, so the gaps are part of the picture.
 *
 * The headline only names a peak month when the data supports one (see
 * `computeSeasonality`): an evenly-billed payee still has a largest month, and
 * announcing that as a season would be inventing a pattern.
 */
export function PayeeSeasonalityPanel({
  monthly,
  currencyStrategy,
  isLoading,
}: PayeeSeasonalityPanelProps) {
  const t = useTranslations('payeeDetail');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency } = useNumberFormat();

  const seasonality = useMemo(() => computeSeasonality(monthly), [monthly]);

  const byMonth = useMemo(
    () => new Map(seasonality.months.map((entry) => [entry.month, entry])),
    [seasonality.months],
  );

  const max = useMemo(
    () =>
      seasonality.months.reduce(
        (highest, entry) => Math.max(highest, Math.abs(entry.average)),
        0,
      ),
    [seasonality.months],
  );

  // A calendar month name in the user's locale, from a fixed non-leap year --
  // only the month is read off it.
  const monthName = (month: number) =>
    formatChartDate(`2001-${String(month).padStart(2, '0')}-01`, 'MMM');

  const headline = (() => {
    if (seasonality.yearsCovered < MIN_YEARS_FOR_SEASONALITY) {
      return t('seasonality.needsMoreHistory', {
        years: MIN_YEARS_FOR_SEASONALITY,
      });
    }
    if (seasonality.peakMonth === null) {
      return t('seasonality.even');
    }
    return t('seasonality.peak', { month: monthName(seasonality.peakMonth) });
  })();

  return (
    <section>
      <div className="mb-4 flex items-center">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('seasonality.title')}
        </h2>
        <InfoTooltip text={t('seasonality.tooltip')} usePortal />
      </div>
      <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
        {isLoading ? (
          <div className="h-40 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
        ) : max === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('seasonality.empty')}
          </p>
        ) : (
          <>
            <p className="mb-4 text-sm text-gray-700 dark:text-gray-300">{headline}</p>
            {/* A row of twelve columns: bar above, month beneath. `items-end`
                grows every bar from a shared baseline so their heights compare. */}
            <ul className="flex items-end gap-1 sm:gap-2">
              {CALENDAR_MONTHS.map((month) => {
                const entry = byMonth.get(month);
                const average = entry?.average ?? 0;
                const height = max > 0 ? (Math.abs(average) / max) * 100 : 0;
                const isPeak = seasonality.peakMonth === month;
                const amount = formatCurrency(
                  Math.abs(average),
                  currencyStrategy.displayCurrency,
                );
                return (
                  <li key={month} className="flex min-w-0 flex-1 flex-col items-center">
                    <div className="flex h-24 w-full items-end justify-center">
                      {entry ? (
                        <div
                          // The title carries the figure: twelve inline amounts
                          // would not fit, and the bar alone is a shape.
                          title={t('seasonality.monthTooltip', {
                            month: monthName(month),
                            amount,
                            years: entry.years,
                          })}
                          // Colour carries the sign, matching the app's other
                          // CSS bars (TopGroupsPanel, CashFlowMiniReport):
                          // money out red, money in green. The peak is the same
                          // hue a couple of steps darker rather than a colour of
                          // its own, so highlighting it does not cost the sign.
                          className={`w-full rounded-t ${
                            average > 0
                              ? isPeak
                                ? 'bg-green-600 dark:bg-green-400'
                                : 'bg-green-400 dark:bg-green-600'
                              : isPeak
                                ? 'bg-red-600 dark:bg-red-400'
                                : 'bg-red-400 dark:bg-red-600'
                          }`}
                          // A month with history but a zero average still shows
                          // a sliver, so it reads as "billed, netted out"
                          // rather than as a month with no history at all.
                          style={{ height: `${Math.max(height, 2)}%` }}
                        />
                      ) : (
                        <div className="h-px w-full bg-gray-200 dark:bg-gray-700" />
                      )}
                    </div>
                    <span
                      className={`mt-1 truncate text-[10px] sm:text-xs ${
                        isPeak
                          ? 'font-semibold text-gray-900 dark:text-gray-100'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {monthName(month)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
