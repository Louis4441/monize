'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import {
  SCHEDULED_KIND_AMOUNT_CLASSES,
  occurrenceKind,
} from '@/lib/scheduled-kind';
import { differenceInDays, startOfDay, parseISO } from 'date-fns';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  nextOccurrenceDueDate,
  nextOccurrenceEffectiveAmount,
  sumEffectiveAmounts,
} from '@/lib/scheduled-effective-amount';
import { UnknownAmount } from '@/components/ui/UnknownAmount';

interface BudgetUpcomingBillsProps {
  scheduledTransactions: ScheduledTransaction[];
  currentSpent: number;
  totalBudgeted: number;
  periodEnd: string;
  formatCurrency: (amount: number) => string;
}

export function BudgetUpcomingBills({
  scheduledTransactions,
  currentSpent,
  totalBudgeted,
  periodEnd,
  formatCurrency,
}: BudgetUpcomingBillsProps) {
  const today = startOfDay(new Date());
  const endDate = parseISO(periodEnd);

  // What this occurrence would cost TODAY, from the server's effective-amount
  // contract (issue #1247). Never `nextOverride?.amount ?? amount`: that scalar
  // was computed at whatever FX rate was current when it was written, so an
  // FX-sensitive schedule made this panel disagree with the cash-flow forecast
  // -- and with what the posting will actually book.
  const getEffective = (st: ScheduledTransaction) =>
    nextOccurrenceEffectiveAmount(st);

  const upcomingBills = useMemo(() => {
    return scheduledTransactions
      .filter((st) => {
        if (!st.isActive) return false;
        // Bills, plus zero-amount reminders: a schedule left at 0 because the
        // amount is not known until it arrives is still a payment the user has
        // to make, and dropping it made it invisible here (issue #1124). It
        // contributes 0 to the total below -- the placeholder is not a claim
        // about what the payment will cost. Deposits and transfers are not
        // budgeted spending and stay out.
        const kind = occurrenceKind(getEffective(st), st);
        if (kind !== 'bill' && kind !== 'reminder') return false;
        const dueDate = parseISO(nextOccurrenceDueDate(st));
        const daysUntil = differenceInDays(dueDate, today);
        const daysUntilEnd = differenceInDays(endDate, dueDate);
        return daysUntil >= 0 && daysUntilEnd >= 0;
      })
      .sort(
        (a, b) =>
          parseISO(nextOccurrenceDueDate(a)).getTime() -
          parseISO(nextOccurrenceDueDate(b)).getTime(),
      );
  }, [scheduledTransactions, today, endDate]);

  // One bill with an unknown current amount makes both this total and "truly
  // available" unknowable, not smaller (issue #1247). The partial sum is kept
  // separately and shown as a subtotal through `PartialTotal`, which is also what
  // tells the reader a figure is missing rather than zero.
  const upcomingTotal = useMemo(
    () => sumEffectiveAmounts(upcomingBills, getEffective, Math.abs),
    [upcomingBills],
  );

  const t = useTranslations('budgets');
  const trulyAvailable =
    upcomingTotal.total === null
      ? null
      : totalBudgeted - currentSpent - upcomingTotal.total;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('upcomingBills.title')}
      </h2>
      {upcomingBills.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('upcomingBills.empty')}
        </p>
      ) : (
        <div className="space-y-2">
          {upcomingBills.slice(0, 5).map((bill) => (
            <div
              key={bill.id}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-gray-900 dark:text-gray-100 truncate">
                  {bill.name}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {nextOccurrenceDueDate(bill)}
                </span>
              </div>
              <span
                className={`font-medium ml-2 whitespace-nowrap ${
                  SCHEDULED_KIND_AMOUNT_CLASSES[
                    occurrenceKind(getEffective(bill), bill)
                  ]
                }`}
              >
                {getEffective(bill).amount === null ? (
                  <UnknownAmount />
                ) : (
                  formatCurrency(Math.abs(getEffective(bill).amount!))
                )}
              </span>
            </div>
          ))}
          {upcomingBills.length > 5 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('upcomingBills.more', { count: String(upcomingBills.length - 5) })}
            </p>
          )}
        </div>
      )}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">{t('upcomingBills.totalUpcoming')}</span>
          {/* A total is only a total when every component is known. One bill
              whose current amount could not be resolved makes this unknowable,
              and the per-bill rows above already mark which one (issue #1247). */}
          {upcomingTotal.total === null ? (
            <UnknownAmount />
          ) : (
            <span className="font-semibold text-red-600 dark:text-red-400">
              {formatCurrency(upcomingTotal.total)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">{t('upcomingBills.trulyAvailable')}</span>
          {/* Derived from the total above, so it is unknown for the same reason.
              Showing a number here would be the whole defect: a budget that
              silently counted a stale bill (issue #1247). */}
          {trulyAvailable === null ? (
            <UnknownAmount />
          ) : (
            <span className={`font-semibold ${gainLossColor(trulyAvailable)}`}>
              {formatCurrency(Math.abs(trulyAvailable))}
              {trulyAvailable < 0 && t('upcomingBills.over')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
