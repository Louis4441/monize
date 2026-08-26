'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  addMonths,
  subMonths,
  getDay,
} from 'date-fns';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import {
  SCHEDULED_KIND_AMOUNT_CLASSES,
  SCHEDULED_KIND_CHIP_CLASSES,
  occurrenceKind,
} from '@/lib/scheduled-kind';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { exportToCsv } from '@/lib/csv-export';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { sumEffectiveAmounts } from '@/lib/scheduled-effective-amount';

/** How far ahead the report projects, matching the three months it always has. */
const HORIZON_MONTHS = 3;

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  bills: UpcomingBill[];
}

interface UpcomingBill {
  scheduledTransaction: ScheduledTransaction;
  dueDate: Date;
  /**
   * What THIS occurrence would post today, from the server's occurrence contract;
   * `null` when it cannot be determined (issue #1247). Never the persisted
   * `amount`, and never the schedule-level figure applied to every projected
   * occurrence -- this report used to do the second, so an occurrence the user
   * had re-priced was listed, totalled and exported at the template's amount.
   */
  amount: number | null;
  /**
   * The currency `amount` is in -- the occurrence's own, which for an investment
   * schedule is the settlement currency rather than the brokerage account's.
   */
  currencyCode: string;
  isOverdue: boolean;
}

export function UpcomingBillsReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [viewType, setViewType] = useState<'calendar' | 'list'>('calendar');

  // The window is fixed for the life of the mount, so the request key is stable
  // across re-renders (the month arrows move the calendar, not the horizon).
  const [through] = useState(() =>
    format(addMonths(new Date(), HORIZON_MONTHS), 'yyyy-MM-dd'),
  );

  // Schedules for their names, kinds and accounts; occurrences for the dates and
  // the amounts. The browser cannot derive the second from the first: expanding
  // the recurrence here gives dates with no per-occurrence amount, which is how
  // one schedule-level figure came to be printed against every occurrence and
  // exported (issue #1247).
  const { data: response, isLoading, error, reload } = useReportData(
    async () => {
      const [schedules, occurrences] = await Promise.all([
        scheduledTransactionsApi.getAll(),
        scheduledTransactionsApi.getOccurrences({ through }),
      ]);
      return { schedules, occurrences };
    },
    [through],
  );

  // Every active schedule is reported, whatever its kind: a transfer between the
  // user's own accounts and a zero-amount reminder both have due dates, and
  // leaving them out made them vanish from the calendar (issue #1124). Their
  // amounts are kept out of the money totals below -- see `summary`.
  const scheduledTransactions = useMemo(
    () => (response?.schedules ?? []).filter((st) => st.isActive),
    [response],
  );

  const upcomingBills = useMemo((): UpcomingBill[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const byId = new Map(scheduledTransactions.map((st) => [st.id, st]));

    // The server orders by due date already; an occurrence whose schedule is not
    // in the active list is skipped rather than drawn without its name.
    return (response?.occurrences ?? []).flatMap((occurrence) => {
      const scheduledTransaction = byId.get(occurrence.scheduledTransactionId);
      if (!scheduledTransaction) return [];
      const dueDate = parseLocalDate(occurrence.dueDate);
      return [
        {
          scheduledTransaction,
          dueDate,
          amount: occurrence.amount,
          currencyCode: occurrence.currencyCode,
          isOverdue: dueDate < today,
        },
      ];
    });
  }, [response, scheduledTransactions]);

  const calendarDays = useMemo((): CalendarDay[] => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);

    // Get the start of the calendar (may include days from prev month)
    const calendarStart = new Date(monthStart);
    calendarStart.setDate(calendarStart.getDate() - getDay(monthStart));

    // Get end of calendar (may include days from next month)
    const calendarEnd = new Date(monthEnd);
    const daysToAdd = 6 - getDay(monthEnd);
    calendarEnd.setDate(calendarEnd.getDate() + daysToAdd);

    const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

    // Build a map of occurrences by date, so the calendar and the list are the
    // same set of occurrences rather than two expansions that can disagree.
    const billsByDate = new Map<string, UpcomingBill[]>();
    upcomingBills.forEach((bill) => {
      const key = format(bill.dueDate, 'yyyy-MM-dd');
      billsByDate.set(key, [...(billsByDate.get(key) ?? []), bill]);
    });

    return days.map((date) => ({
      date,
      isCurrentMonth: isSameMonth(date, currentMonth),
      isToday: isToday(date),
      bills: billsByDate.get(format(date, 'yyyy-MM-dd')) || [],
    }));
  }, [currentMonth, upcomingBills]);

  const summary = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthEnd = endOfMonth(currentMonth);

    const overdue = upcomingBills.filter((b) => b.isOverdue);
    const thisMonth = upcomingBills.filter(
      (b) => !b.isOverdue && b.dueDate <= monthEnd && isSameMonth(b.dueDate, currentMonth)
    );

    // A transfer moves money between the user's own accounts, so it is counted
    // as something coming up but never added to a money total -- summing it
    // beside bills and deposits would overstate both. An occurrence whose
    // current amount is unknown makes the total unknown rather than smaller
    // (issue #1247); the known part is kept separately and never shown under
    // the total's own caption.
    const totalOf = (bills: UpcomingBill[]) =>
      sumEffectiveAmounts(
        bills.filter((b) => !b.scheduledTransaction.isTransfer),
        (b) => ({
          amount: b.amount,
          currencyCode: b.currencyCode,
          complete: b.amount !== null,
        }),
        Math.abs,
      );

    return {
      overdueCount: overdue.length,
      overdueTotal: totalOf(overdue),
      thisMonthCount: thisMonth.length,
      thisMonthTotal: totalOf(thisMonth),
    };
  }, [upcomingBills, currentMonth]);

  const handleBillClick = (_st: ScheduledTransaction) => {
    router.push('/bills');
  };

  const getExportData = () => {
    const headers = [
      t('upcomingBills.csvColBillName'),
      t('upcomingBills.csvColDueDate'),
      t('upcomingBills.csvColAmount'),
      t('upcomingBills.csvColFrequency'),
      t('upcomingBills.csvColAccount'),
      t('upcomingBills.csvColStatus'),
    ];
    const rows: (string | number)[][] = upcomingBills.map((bill) => [
      bill.scheduledTransaction.name,
      format(bill.dueDate, 'yyyy-MM-dd'),
      // An amount nobody can work out is exported as an explicit marker, not as
      // an empty cell (indistinguishable from zero once a spreadsheet totals the
      // column) and not as the stale stored figure (issue #1247).
      bill.amount ?? t('upcomingBills.csvAmountUnavailable'),
      bill.scheduledTransaction.frequency,
      bill.scheduledTransaction.account?.name || '',
      bill.isOverdue ? t('upcomingBills.csvStatusOverdue') : bill.scheduledTransaction.autoPost ? t('upcomingBills.csvStatusAuto') : t('upcomingBills.csvStatusManual'),
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData();
    exportToCsv('upcoming-bills', headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    const pdfCards = [
      { label: t('upcomingBills.pdfActiveBills'), value: String(scheduledTransactions.length), color: '#111827' },
      ...(summary.overdueCount > 0 ? [{ label: t('upcomingBills.pdfOverdue'), value: String(summary.overdueCount), color: '#dc2626' }] : []),
      {
        label: t('upcomingBills.pdfThisMonth'),
        // The total is withheld when any occurrence in it is unknown -- a PDF is
        // a record, so a figure in it must not be a partial sum wearing a
        // total's caption (issue #1247).
        value:
          summary.thisMonthTotal.total === null
            ? `${summary.thisMonthCount} (${t('upcomingBills.amountUnavailable')})`
            : `${summary.thisMonthCount} (${formatCurrency(summary.thisMonthTotal.total)})`,
        color: '#2563eb',
      },
    ];
    await exportToPdf({
      title: t('upcomingBills.pdfTitle'),
      subtitle: t('upcomingBills.pdfSubtitle', { month: format(currentMonth, 'MMMM yyyy'), count: scheduledTransactions.length }),
      summaryCards: pdfCards,
      tableData: { headers, rows },
      filename: 'upcoming-bills',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('upcomingBills.activeBills')}</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {scheduledTransactions.length}
          </div>
        </div>
        {summary.overdueCount > 0 && (
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            <div className="text-sm text-red-600 dark:text-red-400">{t('upcomingBills.overdue')}</div>
            <div className="text-xl font-bold text-red-700 dark:text-red-300">
              {summary.overdueCount}
            </div>
            <div className="text-sm text-red-600 dark:text-red-400">
              {summary.overdueTotal.total === null ? (
                <UnknownAmount />
              ) : (
                formatCurrency(summary.overdueTotal.total)
              )}
            </div>
          </div>
        )}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">{t('upcomingBills.thisMonth')}</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {summary.thisMonthCount}
          </div>
          <div className="text-sm text-blue-600 dark:text-blue-400">
            {summary.thisMonthTotal.total === null ? (
              <UnknownAmount />
            ) : (
              formatCurrency(summary.thisMonthTotal.total)
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 min-w-[160px] text-center">
              {format(currentMonth, 'MMMM yyyy')}
            </h3>
            <button
              onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={() => setCurrentMonth(new Date())}
              className="ml-2 px-3 py-1 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md"
            >
              {t('upcomingBills.todayButton')}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-2">
              <button
                onClick={() => setViewType('calendar')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  viewType === 'calendar'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
              >
                {t('upcomingBills.calendarView')}
              </button>
              <button
                onClick={() => setViewType('list')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  viewType === 'list'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
              >
                {t('upcomingBills.listView')}
              </button>
            </div>
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} disabled={upcomingBills.length === 0} />
          </div>
        </div>
      </div>

      {scheduledTransactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('upcomingBills.noBills')}
          </p>
        </div>
      ) : viewType === 'calendar' ? (
        /* Calendar View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="grid grid-cols-7">
            {([t('upcomingBills.dayLabels.sun'), t('upcomingBills.dayLabels.mon'), t('upcomingBills.dayLabels.tue'), t('upcomingBills.dayLabels.wed'), t('upcomingBills.dayLabels.thu'), t('upcomingBills.dayLabels.fri'), t('upcomingBills.dayLabels.sat')]).map((day) => (
              <div
                key={day}
                className="px-2 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700"
              >
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {calendarDays.map((day, index) => (
              <div
                key={index}
                className={`min-h-[100px] p-1 border-b border-r border-gray-200 dark:border-gray-700 ${
                  !day.isCurrentMonth
                    ? 'bg-gray-50 dark:bg-gray-900/50'
                    : 'bg-white dark:bg-gray-800'
                }`}
              >
                <div
                  className={`text-sm font-medium mb-1 w-7 h-7 flex items-center justify-center rounded-full ${
                    day.isToday
                      ? 'bg-blue-600 text-white'
                      : day.isCurrentMonth
                      ? 'text-gray-900 dark:text-gray-100'
                      : 'text-gray-400 dark:text-gray-600'
                  }`}
                >
                  {format(day.date, 'd')}
                </div>
                <div className="space-y-0.5">
                  {day.bills.slice(0, 3).map((bill, billIndex) => {
                    const st = bill.scheduledTransaction;
                    return (
                      <div
                        key={billIndex}
                        onClick={() => handleBillClick(st)}
                        className={`px-1 py-0.5 text-xs rounded truncate cursor-pointer flex items-center gap-0.5 ${
                          SCHEDULED_KIND_CHIP_CLASSES[occurrenceKind(bill, st)]
                        } hover:opacity-80`}
                        title={st.autoPost ? t('upcomingBills.calendarAutoTitle', { name: st.name }) : t('upcomingBills.calendarManualTitle', { name: st.name })}
                      >
                        {!st.autoPost && (
                          <svg className="h-3 w-3 flex-shrink-0 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01" />
                          </svg>
                        )}
                        <span className="truncate">{st.name}</span>
                      </div>
                    );
                  })}
                  {day.bills.length > 3 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
                      {t('upcomingBills.moreItems', { count: day.bills.length - 3 })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* List View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {upcomingBills.slice(0, 50).map((bill, index) => (
              <div
                key={`${bill.scheduledTransaction.id}-${index}`}
                onClick={() => handleBillClick(bill.scheduledTransaction)}
                className={`px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                  bill.isOverdue ? 'bg-red-50 dark:bg-red-900/10' : ''
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${
                      bill.isOverdue
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-900 dark:text-gray-100'
                    }`}>
                      {bill.scheduledTransaction.name}
                    </span>
                    {bill.isOverdue && (
                      <span className="px-1.5 py-0.5 bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400 text-xs rounded">
                        {t('upcomingBills.overdueLabel')}
                      </span>
                    )}
                    {bill.scheduledTransaction.autoPost ? (
                      <span className="px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400 text-xs rounded" title={t('upcomingBills.autoPostsTitle')}>
                        {t('upcomingBills.autoLabel')}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 text-xs rounded font-medium" title={t('upcomingBills.manualPostTitle')}>
                        {t('upcomingBills.manualLabel')}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {bill.scheduledTransaction.payee?.name || bill.scheduledTransaction.payeeName || t('upcomingBills.noPayee')}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-medium ${
                    SCHEDULED_KIND_AMOUNT_CLASSES[
                      occurrenceKind(bill, bill.scheduledTransaction)
                    ]
                  }`}>
                    {bill.amount === null ? (
                      <UnknownAmount />
                    ) : (
                      formatCurrency(Math.abs(bill.amount))
                    )}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {format(bill.dueDate, 'MMM d, yyyy')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
