'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import {
  PERFORMANCE_PERIODS,
  computePeriodReturn,
  periodStartDate,
  type SecurityPricePoint,
} from '@/lib/security-detail';

interface SecurityPerformanceCardProps {
  /** Full close-price history, oldest first. */
  prices: readonly SecurityPricePoint[];
}

/**
 * Price return over the standard trailing periods.
 *
 * A period the history does not cover reads "n/a" rather than 0%: a security
 * listed two years ago has no five-year return, and a zero there would be a
 * statement about its performance instead of about our data.
 */
export function SecurityPerformanceCard({
  prices,
}: SecurityPerformanceCardProps) {
  const t = useTranslations('securityDetail');
  const { formatSignedPercent } = useNumberFormat();

  const returns = useMemo(
    () =>
      PERFORMANCE_PERIODS.map((period) => ({
        period,
        value: computePeriodReturn(prices, periodStartDate(period)),
      })),
    [prices],
  );

  const hasAny = returns.some((entry) => entry.value !== null);

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('performance.title')}
      </h3>
      {hasAny ? (
        <dl className="space-y-2">
          {returns.map(({ period, value }) => (
            <div key={period} className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-gray-500 dark:text-gray-400">
                {t(`performance.periods.${period}` as Parameters<typeof t>[0])}
              </dt>
              <dd
                className={`text-sm font-medium tabular-nums ${
                  value === null
                    ? 'text-gray-400 dark:text-gray-500'
                    : gainLossColor(value)
                }`}
              >
                {value === null
                  ? t('performance.unavailable')
                  : formatSignedPercent(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('performance.empty')}
        </p>
      )}
    </div>
  );
}
