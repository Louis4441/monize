import { useMemo } from 'react';
import { useReportData } from '@/hooks/useReportData';
import { transactionsApi, type TransactionsGetAllParams } from '@/lib/transactions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { rowDate } from '@/lib/calendar-rows';
import type { Transaction } from '@/types/transaction';
import type { ScheduledOccurrence } from '@/types/scheduled-transaction';

/**
 * How many rows a month's grid will draw before it withholds the layer.
 *
 * A grid is forty-two cells; past this the chips are a wall the reader cannot
 * read, and the honest answer is to say so and point at the filters rather
 * than to draw a thousand of them and let the browser decide which survive.
 */
export const CALENDAR_MAX_ROWS = 1000;

/**
 * What the calendar asks the register for, minus the dates and the page.
 *
 * The month is the date filter in calendar mode, so `startDate`, `endDate`,
 * `page` and `limit` are the hook's to set; everything else is the page's own
 * filter panel, applied by the server exactly as it is for the table.
 */
export type CalendarRowFilters = Omit<
  TransactionsGetAllParams,
  'startDate' | 'endDate' | 'page' | 'limit' | 'targetTransactionId'
>;

export interface CalendarMonthPayload {
  transactions: Transaction[];
  /**
   * Every occurrence the server placed inside the grid, before the account
   * scope is applied -- that step needs the schedules, which are reference
   * data rather than part of this request.
   */
  occurrences: ScheduledOccurrence[];
  /** More rows than the grid will draw; the layer is withheld, not truncated. */
  withheld: boolean;
  rowCount: number;
}

/**
 * The identity of one calendar request: the grid's range and every filter that
 * changes which rows answer it.
 *
 * Built in one expression so the key a caller compares against `dataKey` and
 * the key the fetch was started for cannot drift apart. Undefined and empty
 * filters are dropped rather than stringified, so opening the panel and
 * closing it again does not read as a different question.
 */
export function calendarRequestKey(
  startDate: string,
  endDate: string,
  filters: CalendarRowFilters,
): string {
  const meaningful = Object.entries(filters)
    .filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '',
    )
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));

  return JSON.stringify([startDate, endDate, meaningful]);
}

/**
 * The rows and scheduled occurrences that fall inside one month's grid.
 *
 * Both halves come from the server: the register's own endpoint under the
 * page's filters, and `GET /scheduled-transactions/occurrences`, which prices
 * each occurrence at what it would post today. The client expands no
 * recurrence and sums nothing (design I1, INV-OCCURRENCE-003).
 *
 * Built on `useReportData`, so the payload carries the `dataKey` it belongs to
 * and a failed load stays a failure rather than becoming an empty month.
 */
export function useCalendarMonthData(
  startDate: string,
  endDate: string,
  filters: CalendarRowFilters,
  /**
   * Bumped by the page after a write. A freshness signal, not part of the
   * request key: the same question asked again, not a different one.
   */
  refreshKey: number = 0,
) {
  const requestKey = calendarRequestKey(startDate, endDate, filters);

  const result = useReportData<CalendarMonthPayload>(
    async () => {
      const [transactions, occurrences] = await Promise.all([
        transactionsApi.getAllPages({ ...filters, startDate, endDate }),
        // The endpoint has no lower bound, so it answers from each schedule's
        // next due date -- which is how an overdue occurrence still arrives.
        // The grid's own start is applied here.
        scheduledTransactionsApi.getOccurrences({ through: endDate }),
      ]);

      return {
        transactions,
        occurrences: occurrences.filter((o) => rowDate(o.dueDate) >= startDate),
        withheld: transactions.length > CALENDAR_MAX_ROWS,
        rowCount: transactions.length,
      };
    },
    [requestKey, refreshKey],
    { requestKey },
  );

  /**
   * Whether what is on screen answers the question currently being asked.
   *
   * A month that is still loading may keep the previous one visible, but it
   * must not be actionable: `docs/frontend/api-and-cache.md`, "stale data may
   * stay on screen; it may not stay actionable".
   */
  const isStale = result.data !== null && result.dataKey !== requestKey;

  return useMemo(
    () => ({ ...result, requestKey, isStale }),
    [result, requestKey, isStale],
  );
}
