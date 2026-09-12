'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MonthGrid } from '@/components/ui/MonthGrid';
import { ReportError } from '@/components/reports/ReportError';
import { CalendarBanner, type CalendarCause } from '@/components/calendar/CalendarBanner';
import { CalendarDayCell } from '@/components/calendar/CalendarDayCell';
import { CalendarDayPanel } from '@/components/calendar/CalendarDayPanel';
import { CalendarToolbar } from '@/components/calendar/CalendarToolbar';
import {
  CALENDAR_MAX_ROWS,
  useCalendarMonthData,
  type CalendarRowFilters,
} from '@/hooks/useCalendarMonthData';
import {
  groupCalendarRows,
  type CalendarAccount,
  type CalendarDayRows,
} from '@/lib/calendar-rows';
import { monthGridDays, monthOf, type WeekStart } from '@/lib/calendar-month';
import { occurrenceTouchesAccounts } from '@/lib/scheduled-effective-amount';
import { useViewMode } from '@/store/viewModeStore';
import type { Account, AccountType } from '@/types/account';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Transaction } from '@/types/transaction';

/** How many chips a day cell draws before the rest become a "+N more" line. */
export const CALENDAR_DAY_CHIP_LIMIT = 3;

const LAYERS = ['transactions'] as const;

interface TransactionsCalendarViewProps {
  accounts: readonly Account[];
  scheduledTransactions: readonly ScheduledTransaction[];
  /** The page's filters, minus the date range the month replaces. */
  filters: CalendarRowFilters;
  /** Accounts in scope: the filter's, or every active account when none is chosen. */
  scopeAccountIds: readonly string[];
  weekStartsOn: WeekStart;
  /** Today, for the month the calendar opens on and for dimming a future row. */
  today: string;
  categoryColorMap: ReadonlyMap<string, string | null>;
  categoryIconMap: ReadonlyMap<string, string | null>;
  categoryLabelMap: ReadonlyMap<string, string>;
  onEditTransaction: (transaction: Transaction) => void;
  onCreateOnDay: (date: string) => void;
  /** Bumped by the page after a write, so the month refetches. */
  refreshKey?: number;
}

/**
 * The Transactions page's month calendar.
 *
 * It replaces the register card in calendar mode and nothing else: the filter
 * panel, the chart above it and every write path stay the page's. Its figures
 * are the register endpoint's rows and the occurrence endpoint's amounts, one
 * chip each -- nothing here sums a day, converts a currency or expands a
 * recurrence (design I1).
 */
export function TransactionsCalendarView({
  accounts,
  scheduledTransactions,
  filters,
  scopeAccountIds,
  weekStartsOn,
  today,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
  onEditTransaction,
  onCreateOnDay,
  refreshKey = 0,
}: TransactionsCalendarViewProps) {
  const t = useTranslations('calendar');
  const monthLabelId = useId();
  const { layers, toggleLayer } = useViewMode('transactions');

  const [month, setMonth] = useState(() => monthOf(today));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const days = useMemo(() => monthGridDays(month, weekStartsOn), [month, weekStartsOn]);
  const gridStart = days[0];
  const gridEnd = days[days.length - 1];

  const data = useCalendarMonthData(gridStart, gridEnd, filters, refreshKey);

  const accountsById = useMemo(() => {
    const map = new Map<string, CalendarAccount>();
    for (const account of accounts) {
      map.set(account.id, {
        id: account.id,
        accountType: account.accountType,
        linkedAccountId: account.linkedAccountId,
      });
    }
    return map;
  }, [accounts]);

  const schedulesById = useMemo(
    () => new Map(scheduledTransactions.map((s) => [s.id, s])),
    [scheduledTransactions],
  );

  const scope = useMemo(() => new Set(scopeAccountIds), [scopeAccountIds]);

  const byDay = useMemo(() => {
    if (!data.data || data.data.withheld) return new Map<string, CalendarDayRows>();
    return groupCalendarRows({
      transactions: data.data.transactions,
      // The account scope is applied here rather than in the request: which
      // account an occurrence charges is `occurrenceTouchesAccounts`'s answer,
      // and it needs the schedules, which are reference data.
      occurrences: data.data.occurrences.filter((occurrence) => {
        const schedule = schedulesById.get(occurrence.scheduledTransactionId);
        return (
          schedule !== undefined &&
          occurrenceTouchesAccounts(occurrence, schedule, accountsById, scope)
        );
      }),
      schedulesById,
      accountsById,
      today,
    });
  }, [data.data, schedulesById, accountsById, scope, today]);

  const legend = useMemo(() => {
    const accountTypes = new Set<AccountType>();
    let hasScheduled = false;
    for (const rows of byDay.values()) {
      for (const chip of rows.transactions) {
        accountTypes.add(accountsById.get(chip.transaction.accountId)?.accountType ?? 'OTHER');
      }
      if (rows.occurrences.length > 0) hasScheduled = true;
    }
    return { accountTypes: [...accountTypes], hasScheduled };
  }, [byDay, accountsById]);

  const causes = useMemo<CalendarCause[]>(() => {
    const found: CalendarCause[] = [];
    if (data.data?.withheld) {
      found.push({
        key: 'rowCap',
        message: t('banner.rowCap', {
          count: data.data.rowCount,
          limit: CALENDAR_MAX_ROWS,
        }),
      });
    }
    // A month that draws its rows but not its scheduled items says so here.
    // Silence would read as "nothing is due", which is the one answer the
    // calendar does not have.
    if (data.data?.occurrencesUnavailable) {
      found.push({
        key: 'scheduledUnavailable',
        message: t('banner.scheduledUnavailable'),
      });
    }
    if (data.data?.occurrencesTruncated) {
      found.push({
        key: 'scheduledTruncated',
        message: t('banner.scheduledTruncated'),
      });
    }
    return found;
  }, [data.data, t]);

  // Stale data may stay on screen; it may not stay actionable.
  const isActionable = !data.isLoading && !data.isStale && data.error === null;

  if (data.error !== null && data.data === null) {
    return <ReportError message={t('errors.monthFailed')} onRetry={data.reload} />;
  }

  return (
    <div>
      <CalendarToolbar
        month={month}
        onMonthChange={(next) => {
          setMonth(next);
          setSelectedDate(null);
        }}
        today={today}
        monthLabelId={monthLabelId}
        availableLayers={LAYERS}
        activeLayers={layers}
        onToggleLayer={toggleLayer}
        legendAccountTypes={legend.accountTypes}
        legendHasScheduled={legend.hasScheduled}
      />

      <CalendarBanner causes={causes} />

      {data.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.monthFailed')} onRetry={data.reload} />
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1" aria-busy={data.isLoading} inert={!isActionable}>
          <MonthGrid
            month={month}
            weekStartsOn={weekStartsOn}
            today={today}
            selectedDate={selectedDate}
            onSelectDay={setSelectedDate}
            labelledBy={monthLabelId}
            renderDay={(day) => (
              <CalendarDayCell
                day={day}
                rows={layers.includes('transactions') ? byDay.get(day.date) : undefined}
                chipLimit={CALENDAR_DAY_CHIP_LIMIT}
                onOpenDay={setSelectedDate}
                onEditTransaction={onEditTransaction}
              />
            )}
          />
        </div>

        {selectedDate !== null && (
          <div className="lg:w-80 lg:shrink-0">
            <CalendarDayPanel
              date={selectedDate}
              rows={layers.includes('transactions') ? byDay.get(selectedDate) : undefined}
              onEditTransaction={onEditTransaction}
              onCreateOnDay={onCreateOnDay}
              onClose={() => setSelectedDate(null)}
              categoryColorMap={categoryColorMap}
              categoryIconMap={categoryIconMap}
              categoryLabelMap={categoryLabelMap}
            />
          </div>
        )}
      </div>
    </div>
  );
}
