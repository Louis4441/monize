'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { transactionsApi } from '@/lib/transactions';
import { createLogger } from '@/lib/logger';
import type { Transaction } from '@/types/transaction';

const logger = createLogger('PayeeRecentTransactions');

/** Enough rows to show the pattern; the register link carries the rest. */
const RECENT_LIMIT = 10;

interface PayeeRecentTransactionsProps {
  payeeId: string;
  /** Bumped by the page on every reload so the list refetches in lockstep. */
  refreshKey?: number;
  onViewAll: () => void;
}

/**
 * The payee's latest transactions, newest first. Deliberately a short read-only
 * list with a link out to the register -- embedding the full register here would
 * drag in its filter, edit and pagination machinery for no gain, the same call
 * the account detail pages made.
 */
export function PayeeRecentTransactions({
  payeeId,
  refreshKey,
  onViewAll,
}: PayeeRecentTransactionsProps) {
  const t = useTranslations('payeeDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const requestKey = `${payeeId}:${refreshKey ?? 0}`;
  const isLoading = loadedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    transactionsApi
      .getAll({ payeeId, limit: RECENT_LIMIT, page: 1 })
      .then((result) => {
        if (cancelled) return;
        setTransactions(result.data);
        setError(false);
        setLoadedKey(requestKey);
      })
      .catch((err) => {
        logger.error(err);
        if (cancelled) return;
        setTransactions([]);
        setError(true);
        setLoadedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [payeeId, requestKey]);

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('transactionsTab.title')}
        </h2>
        <Button variant="outline" size="sm" onClick={onViewAll}>
          {t('transactionsTab.viewAll')}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : error ? (
        <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('transactionsTab.loadFailed')}
        </p>
      ) : transactions.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('transactionsTab.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead>
              <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th scope="col" className="py-2 pr-4">
                  {t('transactionsTab.date')}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t('transactionsTab.account')}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t('transactionsTab.category')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {t('transactionsTab.amount')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {transactions.map((transaction) => (
                <tr key={transaction.id} className="text-sm">
                  <td className="whitespace-nowrap py-2 pr-4 text-gray-900 dark:text-gray-100">
                    {formatDate(transaction.transactionDate)}
                  </td>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                    {transaction.account?.name ?? ''}
                  </td>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                    {transaction.category?.name ?? t('transactionsTab.uncategorized')}
                  </td>
                  <td
                    className={`whitespace-nowrap py-2 text-right font-medium tabular-nums ${gainLossColor(
                      transaction.amount,
                    )}`}
                  >
                    {formatCurrency(transaction.amount, transaction.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
