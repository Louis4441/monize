'use client';

import { useTranslations } from 'next-intl';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { Security } from '@/types/investment';

interface SecurityKeyInformationProps {
  security: Security;
  /** Latest close price and the day it is from; null when none is recorded. */
  latestPrice: { price: number; priceDate: string } | null;
}

/**
 * The reference facts about the instrument, beside the chart.
 *
 * Every row comes from a field Monize actually stores, and rows without a value
 * are dropped by `KeyValueList` -- so a thinly-filled security shows a short
 * list rather than a column of dashes. Fields the schema has no column for
 * (ISIN, market cap) are simply absent until there is somewhere to keep them.
 */
export function SecurityKeyInformation({
  security,
  latestPrice,
}: SecurityKeyInformationProps) {
  const t = useTranslations('securityDetail');
  const ts = useTranslations('securities');
  const { formatDate } = useDateFormat();
  const { formatCurrencyPrecise } = useNumberFormat();
  // A security with no provider of its own inherits the user's default, so the
  // effective provider is the answer here -- never a blank row.
  const defaultQuoteProvider =
    usePreferencesStore((s) => s.preferences?.defaultQuoteProvider) ?? 'yahoo';

  const rows: KeyValueRow[] = [
    { key: 'symbol', label: t('keyInfo.symbol'), value: security.symbol },
    {
      // "Security type", not "asset class": an ETF is a kind of instrument, not
      // an asset class, and the latter term is needed for the percentage
      // breakdown a security can carry (review of discussion #964).
      key: 'securityType',
      label: t('keyInfo.securityType'),
      value: security.securityType
        ? ts(`typeLabels.${security.securityType}` as Parameters<typeof ts>[0])
        : null,
    },
    { key: 'exchange', label: t('keyInfo.exchange'), value: security.exchange },
    {
      key: 'currency',
      label: t('keyInfo.currency'),
      value: security.currencyCode,
    },
    { key: 'sector', label: t('keyInfo.sector'), value: security.sector },
    { key: 'industry', label: t('keyInfo.industry'), value: security.industry },
    {
      key: 'provider',
      label: t('keyInfo.provider'),
      value: ts(
        `form.providers.${security.quoteProvider ?? defaultQuoteProvider}` as Parameters<
          typeof ts
        >[0],
      ),
    },
    {
      key: 'lastPrice',
      label: t('keyInfo.lastPrice'),
      value: latestPrice
        ? `${formatCurrencyPrecise(latestPrice.price, security.currencyCode)} (${formatDate(latestPrice.priceDate)})`
        : null,
    },
  ];

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('keyInfo.title')}
      </h3>
      <KeyValueList rows={rows} />
    </div>
  );
}
