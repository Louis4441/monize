'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format, subMonths } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';
import type { RecurringChargeInfo } from '@/types/transaction';

const logger = createLogger('RecurringChargesPanel');

// Cadences worth surfacing as a "subscription"; irregular activity is noise.
const SUBSCRIPTION_CADENCES = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);

interface RecurringChargesPanelProps {
  accountId: string;
  currencyCode: string;
}

/**
 * Recurring charges ("subscriptions") that live on an account. The
 * recurring-charges endpoint is payee-scoped, so this derives the account's
 * payees from its recent transactions first, then classifies their cadence.
 * Shared by the credit-card and banking detail views.
 */
export function RecurringChargesPanel({ accountId, currencyCode }: RecurringChargesPanelProps) {
  const t = useTranslations('accountDetail');
  const { formatCurrency } = useNumberFormat();

  const [charges, setCharges] = useState<RecurringChargeInfo[]>([]);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const isLoading = loadedForId !== accountId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      const endDate = format(now, 'yyyy-MM-dd');
      const startDate = format(subMonths(now, 12), 'yyyy-MM-dd');
      try {
        const page = await transactionsApi.getAll({
          accountId,
          startDate,
          endDate,
          limit: 500,
          page: 1,
        });
        const payeeIds = Array.from(
          new Set(page.data.map((tx) => tx.payeeId).filter((id): id is string => !!id)),
        );
        const detected = payeeIds.length
          ? await transactionsApi.getRecurringCharges({ payeeIds, startDate, endDate })
          : [];
        if (cancelled) return;
        setCharges(detected.filter((c) => SUBSCRIPTION_CADENCES.has(c.frequency)));
      } catch (error) {
        if (cancelled) return;
        logger.error('Failed to load recurring charges:', error);
        setCharges([]);
      }
      if (!cancelled) setLoadedForId(accountId);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const sorted = [...charges].sort((a, b) => b.dates.length - a.dates.length);

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('recurring.title')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('recurring.subtitle')}</p>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-20 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : sorted.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('recurring.empty')}</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {sorted.map((c, i) => (
              <li key={`${c.payeeName}-${i}`} className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {c.payeeName}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t(`recurring.frequency.${c.frequency}` as 'recurring.frequency.monthly')}
                    {c.categoryName ? ` · ${c.categoryName}` : ''}
                  </div>
                </div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                  {formatCurrency(Math.abs(c.currentAmount), currencyCode)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
