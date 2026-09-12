'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { balanceColor } from '@/lib/format';
import type { MonthGridDay } from '@/components/ui/MonthGrid';
import type { CalendarDayRows } from '@/lib/calendar-rows';
import type { DailyBalanceTotal } from '@/types/account';
import type { Transaction } from '@/types/transaction';

interface CalendarDayCellProps {
  day: MonthGridDay;
  /** What falls on this day, or undefined for a day with nothing on it. */
  rows?: CalendarDayRows;
  /** How many chips are drawn before the rest become a "+N more" line. */
  chipLimit: number;
  onOpenDay: (date: string) => void;
  onEditTransaction: (transaction: Transaction) => void;
  /** The Balances layer's figure for this day, when that layer is on. */
  figure?: ReactNode;
}

const CHIP =
  'block w-full truncate rounded px-1 py-0.5 text-left text-xs transition-opacity motion-reduce:transition-none hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/**
 * One day of the Transactions calendar: its number, its chips, and whatever
 * the Balances layer has to say about it.
 *
 * Every figure printed here is the one the server sent for that row or that
 * occurrence. The cell adds nothing up -- a day's total is not a number this
 * calendar claims to know (design I1).
 */
export function CalendarDayCell({
  day,
  rows,
  chipLimit,
  onOpenDay,
  onEditTransaction,
  figure,
}: CalendarDayCellProps) {
  const t = useTranslations('calendar');
  const { formatCurrency } = useNumberFormat();
  const payeeDisplay = usePayeeDisplay();

  const transactions = rows?.transactions ?? [];
  const occurrences = rows?.occurrences ?? [];
  const total = transactions.length + occurrences.length;
  const shownTransactions = transactions.slice(0, chipLimit);
  const shownOccurrences = occurrences.slice(
    0,
    Math.max(0, chipLimit - shownTransactions.length),
  );
  const hidden = total - shownTransactions.length - shownOccurrences.length;

  return (
    <div className="min-h-[6rem] sm:min-h-[7rem] flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-1">
        <span
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium ${
            day.isToday
              ? 'bg-blue-600 text-white'
              : day.isCurrentMonth
                ? 'text-gray-900 dark:text-gray-100'
                : 'text-gray-400 dark:text-gray-600'
          }`}
        >
          {Number(day.date.slice(-2))}
        </span>
        {figure}
      </div>

      {/* Below sm the chips are dots: a phone cell has no room for a label,
          and the day panel is the reading surface there. */}
      <div className="sm:hidden flex flex-wrap gap-0.5" aria-hidden="true">
        {shownTransactions.map((chip) => (
          <span key={chip.key} className={`h-1.5 w-1.5 rounded-full ${chip.className}`} />
        ))}
        {shownOccurrences.map((chip) => (
          <span
            key={chip.key}
            className={`h-1.5 w-1.5 rounded-full border border-dashed border-current ${chip.className}`}
          />
        ))}
      </div>

      <div className="hidden sm:flex flex-col gap-0.5">
        {shownTransactions.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => onEditTransaction(chip.transaction)}
            className={`${CHIP} ${chip.className} ${chip.isVoid ? 'line-through opacity-50' : ''} ${
              chip.isFuture && !chip.isVoid ? 'opacity-60' : ''
            }`}
          >
            {payeeDisplay(chip.transaction) ?? t('chip.noPayee')}{' '}
            {formatCurrency(Number(chip.transaction.amount), chip.transaction.currencyCode)}
          </button>
        ))}

        {shownOccurrences.map((chip) => (
          <Link
            key={chip.key}
            href={`/bills?highlight=${chip.occurrence.scheduledTransactionId}`}
            className={`${CHIP} border border-dashed border-current ${chip.className}`}
          >
            <span className="inline-flex items-center gap-1">
              {chip.isOverdue ? (
                <ExclamationTriangleIcon
                  className="w-3 h-3 shrink-0"
                  aria-label={t('chip.overdue')}
                />
              ) : (
                <ClockIcon className="w-3 h-3 shrink-0" aria-label={t('chip.scheduled')} />
              )}
              <span className="truncate">{chip.schedule.name}</span>
              {chip.occurrence.amount === null ? (
                <UnknownAmount />
              ) : (
                <span>
                  {formatCurrency(chip.occurrence.amount, chip.occurrence.currencyCode)}
                </span>
              )}
            </span>
          </Link>
        ))}
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onOpenDay(day.date)}
          className="mt-auto self-start px-1 text-xs text-gray-500 dark:text-gray-400 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {t('day.moreChips', { count: hidden })}
        </button>
      )}
    </div>
  );
}

/**
 * The Balances layer's figure for one day, as the cell prints it.
 *
 * The number, the currency and the projected-or-actual decision are all the
 * server's (design I2): this reads `total` and `isProjected` off the day it was
 * handed and renders them. It never sums, converts, or compares a date with the
 * browser's clock.
 *
 * A `null` total is the unknown marker, never `knownSubtotal` wearing a total's
 * caption -- the partial sum has its own line in the day panel, where there is
 * room to say it is partial.
 */
export function CalendarBalanceFigure({
  point,
  currencyCode,
}: {
  point: DailyBalanceTotal;
  currencyCode: string;
}) {
  const t = useTranslations('calendar');
  const { formatCurrency } = useNumberFormat();

  if (point.total === null) {
    // Which unknown this is decides which screen repairs it: a missing pair is
    // a rate to add, an unpriceable projection is a schedule to look at.
    return (
      <UnknownAmount
        reason={point.missingRatePairs.length > 0 ? 'displayFx' : 'scheduledFx'}
        className="text-xs"
      />
    );
  }

  return (
    <span
      className={`inline-flex items-baseline gap-0.5 text-xs tabular-nums ${balanceColor(
        point.total,
      )} ${point.isProjected ? 'italic' : ''}`}
      data-testid={point.isProjected ? 'calendar-balance-projected' : 'calendar-balance-actual'}
    >
      {point.isProjected && (
        <ClockIcon className="w-3 h-3 shrink-0 self-center" aria-label={t('balance.projected')} />
      )}
      {formatCurrency(point.total, currencyCode)}
    </span>
  );
}
