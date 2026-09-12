'use client';

import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import {
  monthGridDays,
  monthOf,
  rotateWeekdayLabels,
  type WeekStart,
} from '@/lib/calendar-month';

interface MonthGridProps {
  /** The month to draw, `YYYY-MM`. */
  month: string;
  /** `0` is Sunday, as `user_preferences.week_starts_on` numbers the week. */
  weekStartsOn: WeekStart;
  /** The server's financial today, `YYYY-MM-DD`; marks one cell `aria-current`. */
  today: string;
  /** The day whose panel is open, if any. */
  selectedDate?: string | null;
  onSelectDay?: (date: string) => void;
  /** What goes inside a day's cell. The grid never looks at it. */
  renderDay: (day: MonthGridDay) => ReactNode;
  /** Id of the element naming this grid, usually the toolbar's month caption. */
  labelledBy?: string;
}

export interface MonthGridDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** False for the days borrowed from the adjacent months to fill the weeks. */
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
}

/**
 * The month grid, and nothing else.
 *
 * It lays out whole weeks, labels the columns in the reader's week order,
 * carries the grid keyboard pattern, and hands each day to `renderDay`. It
 * knows no money, no filter and no endpoint: everything a cell prints is
 * decided by the view that owns the data, which is what lets the Transactions
 * and Investments calendars share one grid without sharing a contract.
 *
 * `components/bills/ScheduledCalendarGrid.tsx` is the one other month layout
 * left; it migrates onto this component in its own change.
 */
export function MonthGrid({
  month,
  weekStartsOn,
  today,
  selectedDate = null,
  onSelectDay,
  renderDay,
  labelledBy,
}: MonthGridProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const { formatDate } = useDateFormat();

  const days = monthGridDays(month, weekStartsOn);
  const labels = rotateWeekdayLabels(common.raw('weekdaysMin') as string[], weekStartsOn);

  const cellRefs = useRef(new Map<string, HTMLDivElement>());

  /**
   * The cell holding the grid's single tab stop.
   *
   * A grid is one tab stop, not forty-two: tabbing through a month before
   * reaching the page's next control is what the roving pattern exists to
   * avoid.
   */
  const [focusedDate, setFocusedDate] = useState(() => defaultFocus(days, month, today, selectedDate));

  // Reset the tab stop when the month moves, without an effect: the day it
  // pointed at is not in the new grid, and a focused cell that no longer
  // exists leaves the grid unreachable by keyboard.
  const [renderedMonth, setRenderedMonth] = useState(month);
  if (renderedMonth !== month) {
    setRenderedMonth(month);
    setFocusedDate(defaultFocus(days, month, today, selectedDate));
  }

  const focusCell = useCallback((date: string) => {
    setFocusedDate(date);
    cellRefs.current.get(date)?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      const move = KEY_STEPS[event.key];
      if (move !== undefined) {
        const next = days[index + move];
        // The grid does not wrap into the previous or next month: the reader
        // moves months with the toolbar, where the month caption changes with
        // them.
        if (next) {
          event.preventDefault();
          focusCell(next);
        }
        return;
      }

      activateOnKey(() => onSelectDay?.(days[index]))(event);
    },
    [days, focusCell, onSelectDay],
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>, date: string) => {
      // A chip inside the cell is its own control with its own destination;
      // the cell responds only to a click on the cell itself.
      const target = event.target as HTMLElement;
      if (target.closest('button, a, input, select, textarea')) return;

      setFocusedDate(date);
      onSelectDay?.(date);
    },
    [onSelectDay],
  );

  return (
    <div
      role="grid"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : t('grid.label')}
      className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700"
    >
      <div role="row" className="grid grid-cols-7">
        {labels.map((label) => (
          <div
            key={label}
            role="columnheader"
            className="min-w-0 truncate px-1 py-2 text-center text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700"
          >
            {label}
          </div>
        ))}
      </div>

      {chunkWeeks(days).map((week) => (
        <div key={week[0]} role="row" className="grid grid-cols-7">
          {week.map((date) => {
            const index = days.indexOf(date);
            const isSelected = date === selectedDate;
            const isToday = date === today;

            return (
              <div
                key={date}
                role="gridcell"
                ref={(node) => {
                  if (node) cellRefs.current.set(date, node);
                  else cellRefs.current.delete(date);
                }}
                tabIndex={date === focusedDate ? 0 : -1}
                aria-label={formatDate(date)}
                aria-selected={isSelected}
                aria-current={isToday ? 'date' : undefined}
                onClick={(event) => handleClick(event, date)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={`min-w-0 p-1 border-b border-r border-gray-200 dark:border-gray-700 ${INTERACTIVE_ROW_FOCUS_CLASS} ${
                  monthOf(date) === month
                    ? 'bg-white dark:bg-gray-800'
                    : 'bg-gray-50 dark:bg-gray-900/50'
                } ${isSelected ? 'ring-2 ring-inset ring-blue-500' : ''}`}
              >
                {renderDay({
                  date,
                  isCurrentMonth: monthOf(date) === month,
                  isToday,
                  isSelected,
                })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Arrow keys step a day; up and down step a week. */
const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

/**
 * Where the tab stop sits when the grid is first drawn or the month moves:
 * the open day, else today, else the 1st of the month on show.
 */
function defaultFocus(
  days: string[],
  month: string,
  today: string,
  selectedDate: string | null,
): string {
  if (selectedDate && days.includes(selectedDate)) return selectedDate;
  if (days.includes(today)) return today;
  return `${month}-01`;
}

function chunkWeeks(days: string[]): string[][] {
  const weeks: string[][] = [];
  for (let start = 0; start < days.length; start += 7) {
    weeks.push(days.slice(start, start + 7));
  }
  return weeks;
}
