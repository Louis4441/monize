'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClockIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { CARD_CLASS, HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { CategoryPill } from '@/components/transactions/CategoryPill';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { BalanceForecastUnavailable } from '@/components/accounts/shared/BalanceForecastUnavailable';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { balanceColor } from '@/lib/format';
import type { CalendarDayRows } from '@/lib/calendar-rows';
import type { DailyBalanceTotal, DailyBalanceTotalsResponse } from '@/types/account';
import type { Transaction } from '@/types/transaction';

/** What the Balances layer knows about the day this panel is open on. */
export interface CalendarDayBalance {
  point: DailyBalanceTotal;
  /** The currency the total is reported in, which every scoped day shares. */
  currencyCode: string;
  /** The month's forecast state; a projected day is withheld whole on one gap. */
  forecast: DailyBalanceTotalsResponse['forecast'];
}

interface CalendarDayPanelProps {
  /** The day this panel is about, `YYYY-MM-DD`. */
  date: string;
  rows?: CalendarDayRows;
  /** Present only while the Balances layer is on and this day's figure arrived. */
  balance?: CalendarDayBalance;
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
  balance,
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

      {balance && (
        <CalendarDayBalanceSection balance={balance} hasOccurrences={occurrences.length > 0} />
      )}

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

/**
 * What the Balances layer has to say about the open day, in full.
 *
 * The cell has room for a figure and a marker; this is where the figure's
 * provenance goes -- whether it is an actual or a projection, and, when it is
 * withheld, which currency pair or which schedule withheld it. A withheld figure
 * that names no cause is a dead end, so every branch here ends in something the
 * reader can act on.
 */
function CalendarDayBalanceSection({
  balance,
  hasOccurrences,
}: {
  balance: CalendarDayBalance;
  hasOccurrences: boolean;
}) {
  const t = useTranslations('calendar');
  const { formatCurrency } = useNumberFormat();
  const { point, currencyCode, forecast } = balance;

  // A projected day is withheld whole when any scoped forecast is incomplete,
  // which is the server's decision; the gaps are what it withheld it for.
  const showGaps = point.isProjected && !forecast.complete;

  return (
    <section
      className="mb-3 border-b border-gray-200 dark:border-gray-700 pb-3"
      aria-label={point.isProjected ? t('balance.projectedTitle') : t('balance.actualTitle')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {point.isProjected ? t('balance.projectedTitle') : t('balance.actualTitle')}
        </h4>
        {point.total === null ? (
          <UnknownAmount reason={point.missingRatePairs.length > 0 ? 'displayFx' : 'scheduledFx'} />
        ) : (
          <span
            className={`text-sm font-semibold tabular-nums ${balanceColor(point.total)} ${
              point.isProjected ? 'italic' : ''
            }`}
          >
            {formatCurrency(point.total, currencyCode)}
          </span>
        )}
      </div>

      {/* The partial sum, and only ever under a caption that says it is one. */}
      {point.total === null && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('balance.partial', {
            amount: formatCurrency(point.knownSubtotal, currencyCode),
          })}
        </p>
      )}

      {point.isProjected && point.total !== null && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {hasOccurrences ? t('balance.projectedFromItems') : t('balance.projectedHint')}
        </p>
      )}

      {point.missingRatePairs.length > 0 && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          {t('balance.missingRates', { pairs: point.missingRatePairs.join(', ') })}
        </p>
      )}

      {showGaps && (
        <div className="mt-2">
          <BalanceForecastUnavailable gaps={forecast.gaps} />
        </div>
      )}

      {point.isProjected && forecast.unforecastableAccountIds.length > 0 && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          {t('balance.unforecastable', { count: forecast.unforecastableAccountIds.length })}
        </p>
      )}
    </section>
  );
}
