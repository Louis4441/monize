'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClockIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { CARD_CLASS, HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { CategoryPill } from '@/components/transactions/CategoryPill';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import type { CalendarDayRows } from '@/lib/calendar-rows';
import type { Transaction } from '@/types/transaction';

interface CalendarDayPanelProps {
  /** The day this panel is about, `YYYY-MM-DD`. */
  date: string;
  rows?: CalendarDayRows;
  onEditTransaction: (transaction: Transaction) => void;
  onCreateOnDay: (date: string) => void;
  onClose: () => void;
  categoryColorMap: ReadonlyMap<string, string | null>;
  categoryIconMap: ReadonlyMap<string, string | null>;
  categoryLabelMap: ReadonlyMap<string, string>;
}

/**
 * One day, in full: every row and occurrence on it, and the way to add another.
 *
 * The cell is a summary bounded by its own height; this is the surface that
 * shows the day whole. Clicking a row opens the register's own edit modal, so
 * the calendar adds no write path of its own (design I9).
 */
export function CalendarDayPanel({
  date,
  rows,
  onEditTransaction,
  onCreateOnDay,
  onClose,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
}: CalendarDayPanelProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const payeeDisplay = usePayeeDisplay();

  const transactions = rows?.transactions ?? [];
  const occurrences = rows?.occurrences ?? [];

  return (
    <aside className={`${CARD_CLASS} p-4`} aria-label={formatDate(date)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {formatDate(date)}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={common('close')}
          className={`p-1 rounded text-gray-500 dark:text-gray-400 ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>

      {transactions.length === 0 && occurrences.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('day.noItems')}</p>
      ) : (
        <ul className="space-y-2">
          {transactions.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                onClick={() => onEditTransaction(chip.transaction)}
                className={`w-full rounded px-2 py-1.5 text-left ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  chip.isVoid ? 'line-through opacity-50' : ''
                } ${chip.isFuture && !chip.isVoid ? 'opacity-60' : ''}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                    {payeeDisplay(chip.transaction) ?? t('chip.noPayee')}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                    {formatCurrency(
                      Number(chip.transaction.amount),
                      chip.transaction.currencyCode,
                    )}
                  </span>
                </span>
                {chip.transaction.categoryId && (
                  <span className="mt-1 block">
                    <CategoryPill
                      name={categoryLabelMap.get(chip.transaction.categoryId) ?? ''}
                      color={categoryColorMap.get(chip.transaction.categoryId) ?? null}
                      icon={categoryIconMap.get(chip.transaction.categoryId) ?? null}
                      density="normal"
                    />
                  </span>
                )}
              </button>
            </li>
          ))}

          {occurrences.map((chip) => (
            <li key={chip.key}>
              <Link
                href={`/bills?highlight=${chip.occurrence.scheduledTransactionId}`}
                className={`block rounded px-2 py-1.5 ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-1">
                    {chip.isOverdue ? (
                      <ExclamationTriangleIcon
                        className="w-3.5 h-3.5 shrink-0 self-center"
                        aria-label={t('chip.overdue')}
                      />
                    ) : (
                      <ClockIcon
                        className="w-3.5 h-3.5 shrink-0 self-center"
                        aria-label={t('chip.scheduled')}
                      />
                    )}
                    <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                      {chip.schedule.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                    {chip.occurrence.amount === null ? (
                      <UnknownAmount />
                    ) : (
                      formatCurrency(chip.occurrence.amount, chip.occurrence.currencyCode)
                    )}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  {t('day.scheduledHint')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        size="sm"
        className="mt-4 w-full"
        onClick={() => onCreateOnDay(date)}
      >
        {t('day.newTransaction')}
      </Button>
    </aside>
  );
}
