'use client';

import { useTranslations } from 'next-intl';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import type { SecurityDetail } from '@/types/investment';

interface SecurityPositionInfoCardProps {
  detail: SecurityDetail;
}

/**
 * Lifetime totals for this security: what went in, what came out, and where the
 * position stands now. Amounts are in the security's own currency, matching the
 * transaction table below.
 */
export function SecurityPositionInfoCard({
  detail,
}: SecurityPositionInfoCardProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const { activity, security } = detail;
  const currency = security.currencyCode;

  const status = !detail.hasTransactions
    ? { label: t('positionInfo.statusNone'), tone: 'neutral' as const }
    : detail.isPositionClosed
      ? { label: t('positionInfo.statusClosed'), tone: 'neutral' as const }
      : { label: t('positionInfo.statusOpen'), tone: 'open' as const };

  const rows: KeyValueRow[] = [
    {
      key: 'firstTransaction',
      label: t('positionInfo.firstTransaction'),
      value: activity.firstTransactionDate
        ? formatDate(activity.firstTransactionDate)
        : null,
    },
    {
      key: 'lastTransaction',
      label: t('positionInfo.lastTransaction'),
      value: activity.lastTransactionDate
        ? formatDate(activity.lastTransactionDate)
        : null,
    },
    {
      key: 'totalInvested',
      label: t('positionInfo.totalInvested'),
      value: formatCurrency(activity.totalInvested, currency),
    },
    {
      key: 'totalSold',
      label: t('positionInfo.totalSold'),
      value: formatCurrency(activity.totalSold, currency),
    },
    {
      key: 'dividends',
      label: t('positionInfo.dividends'),
      value: formatCurrency(activity.dividends, currency),
    },
    {
      key: 'fees',
      label: t('positionInfo.fees'),
      value: formatCurrency(activity.fees, currency),
    },
    {
      key: 'realizedPl',
      label: t('positionInfo.realizedPl'),
      // Denominated in the holding account's currency, not the security's, and
      // absent entirely when sales spanned several currencies -- KeyValueList
      // drops the row rather than showing a figure in no currency at all.
      value:
        activity.realizedGain === null || activity.realizedGainCurrency === null
          ? null
          : (
              <span className={gainLossColor(activity.realizedGain)}>
                {activity.realizedGain >= 0 ? '+' : ''}
                {formatCurrency(
                  activity.realizedGain,
                  activity.realizedGainCurrency,
                )}
              </span>
            ),
    },
    {
      key: 'status',
      label: t('positionInfo.status'),
      value: (
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            status.tone === 'open'
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
          }`}
        >
          {status.label}
        </span>
      ),
    },
  ];

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('positionInfo.title')}
      </h3>
      <KeyValueList rows={rows} />
    </div>
  );
}
