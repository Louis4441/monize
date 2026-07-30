'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import {
  PERFORMANCE_PERIODS,
  computePeriodReturn,
  periodStartDate,
  inferDistributionPolicy,
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
 *
 * The caption says whether dividends are in these figures. They are whenever the
 * provider supplies an adjusted close; when it does not, the returns are measured
 * on price alone and a fund that pays out looks worse than it was by its whole
 * yield -- which is worth saying out loud rather than leaving to be discovered.
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
  // `unknown` means no adjusted series exists, so these returns exclude dividends.
  const includesDividends = inferDistributionPolicy(prices) !== 'unknown';

  return (
    <div className="flex h-full flex-col rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('performance.title')}
      </h3>
      {/* These are the security's returns, not the holder's: they measure the
          instrument over a window regardless of when it was bought or whether it
          was held at all. Readers take any "Performance" heading on a page about
          their own holding to mean their own return, so the card says which one
          it is and where to find the other. */}
      <p className="mb-3 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        {t('performance.subject')}
      </p>
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
      {hasAny &&
        (includesDividends ? (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {t('performance.includesDividends')}
          </p>
        ) : (
          <p
            className="mt-3 text-xs text-amber-600 dark:text-amber-500"
            title={t('performance.excludesDividendsTitle')}
          >
            {t('performance.excludesDividends')}
          </p>
        ))}
    </div>
  );
}
