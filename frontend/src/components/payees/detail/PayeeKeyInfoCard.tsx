'use client';

import { useTranslations } from 'next-intl';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { PayeeDetail } from '@/types/payee';

interface PayeeKeyInfoCardProps {
  detail: PayeeDetail;
  /**
   * Hierarchical category labels ("Parent: Child"), so the default category
   * reads the same here as it does in the payee list and the filter dropdowns.
   * A bare leaf name is ambiguous -- several parents can own a "Fees".
   */
  categoryLabelMap: Map<string, string>;
  /** Narrow the register to one day (for the largest transaction). */
  onSelectDate: (date: string) => void;
  /** Open an account's detail page (for the overpayment designation). */
  onSelectAccount: (accountId: string) => void;
}

/**
 * The reference facts about the payee, beside the chart. Rows without a value
 * are dropped by `KeyValueList`, so a fresh payee shows a short list rather
 * than a column of dashes.
 */
export function PayeeKeyInfoCard({
  detail,
  categoryLabelMap,
  onSelectDate,
  onSelectAccount,
}: PayeeKeyInfoCardProps) {
  const t = useTranslations('payeeDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  const { payee, stats, largestTransaction, overpaymentForAccounts } = detail;

  const rows: KeyValueRow[] = [
    {
      key: 'defaultCategory',
      label: t('keyInfo.defaultCategory'),
      // The map wins over the relation's own name: it carries the parent, and
      // the relation only ever holds the leaf.
      value: payee.defaultCategoryId
        ? (categoryLabelMap.get(payee.defaultCategoryId) ??
          payee.defaultCategory?.name ??
          null)
        : null,
    },
    {
      key: 'status',
      label: t('keyInfo.status'),
      value: payee.isActive ? t('keyInfo.active') : t('keyInfo.inactive'),
    },
    {
      key: 'created',
      label: t('keyInfo.created'),
      value: payee.createdAt ? formatDate(payee.createdAt) : null,
    },
    {
      key: 'firstTransaction',
      label: t('keyInfo.firstTransaction'),
      value: stats.firstTransactionDate ? formatDate(stats.firstTransactionDate) : null,
    },
    {
      key: 'lastTransaction',
      label: t('keyInfo.lastTransaction'),
      value: stats.lastTransactionDate ? formatDate(stats.lastTransactionDate) : null,
    },
    {
      key: 'aliases',
      label: t('keyInfo.aliases'),
      value: stats.aliasCount > 0 ? stats.aliasCount.toLocaleString() : null,
    },
    {
      key: 'largestTransaction',
      label: t('keyInfo.largestTransaction'),
      value: largestTransaction ? (
        <button
          type="button"
          onClick={() => onSelectDate(largestTransaction.transactionDate)}
          className="text-right text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('keyInfo.largestValue', {
            amount: formatCurrency(
              Math.abs(largestTransaction.amount),
              largestTransaction.currencyCode,
            ),
            date: formatDate(largestTransaction.transactionDate),
          })}
        </button>
      ) : null,
    },
    {
      key: 'overpaymentFor',
      label: t('keyInfo.overpaymentFor'),
      value:
        overpaymentForAccounts.length > 0 ? (
          <span className="inline-flex flex-wrap justify-end gap-x-2">
            {overpaymentForAccounts.map((account) => (
              <button
                key={account.accountId}
                type="button"
                onClick={() => onSelectAccount(account.accountId)}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {account.accountName}
              </button>
            ))}
          </span>
        ) : null,
    },
    {
      key: 'notes',
      label: t('keyInfo.notes'),
      value: payee.notes || null,
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
