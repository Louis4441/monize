'use client';

import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { useDateFormat } from '@/hooks/useDateFormat';
import { shiftMonth } from '@/lib/calendar-month';
import { SCHEDULED_KIND_CHIP_CLASSES } from '@/lib/scheduled-kind';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import type { AccountType } from '@/types/account';
import type { CalendarLayer } from '@/store/viewModeStore';

interface CalendarToolbarProps {
  /** `YYYY-MM`. */
  month: string;
  onMonthChange: (month: string) => void;
  /** The server's financial today; the Today button goes to its month. */
  today: string;
  /** Id the grid points `aria-labelledby` at, so the grid is named by its month. */
  monthLabelId: string;
  /** The layers this surface offers, in toolbar order. */
  availableLayers: readonly CalendarLayer[];
  activeLayers: readonly CalendarLayer[];
  onToggleLayer: (layer: CalendarLayer) => void;
  /** Account types present in the month, for the legend. */
  legendAccountTypes: readonly AccountType[];
  /** Whether the month holds any scheduled occurrence. */
  legendHasScheduled: boolean;
}

const NAV_BUTTON =
  `p-1.5 rounded-md text-gray-600 dark:text-gray-300 ${HOVER_ROW_ON_PAGE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`;

const LAYER_BUTTON =
  'px-3 py-1 text-sm font-medium rounded-md border transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
const LAYER_ON =
  'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300';
const LAYER_OFF =
  `border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400 ${HOVER_ROW_ON_PAGE}`;

/**
 * The row above the grid: which month, which layers, and what the colours mean.
 *
 * The month is the calendar's own state rather than the page's date filter
 * (design decision 2), so the navigation here is the only thing that moves it.
 */
export function CalendarToolbar({
  month,
  onMonthChange,
  today,
  monthLabelId,
  availableLayers,
  activeLayers,
  onToggleLayer,
  legendAccountTypes,
  legendHasScheduled,
}: CalendarToolbarProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const { formatMonth } = useDateFormat();

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={NAV_BUTTON}
          // The same two words the date picker's own month arrows carry:
          // one catalog entry, so every surface says it the same way.
          aria-label={common('dateInput.previousMonth')}
          onClick={() => onMonthChange(shiftMonth(month, -1))}
        >
          <ChevronLeftIcon className="w-5 h-5" />
        </button>
        <h2
          id={monthLabelId}
          className="min-w-[9rem] text-center text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          {formatMonth(month)}
        </h2>
        <button
          type="button"
          className={NAV_BUTTON}
          aria-label={common('dateInput.nextMonth')}
          onClick={() => onMonthChange(shiftMonth(month, 1))}
        >
          <ChevronRightIcon className="w-5 h-5" />
        </button>
        <button
          type="button"
          className={`${LAYER_BUTTON} ${LAYER_OFF} ml-1`}
          onClick={() => onMonthChange(today.slice(0, 7))}
        >
          {common('calendar.today')}
        </button>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label={t('toolbar.layers')}>
        {availableLayers.map((layer) => (
          <button
            key={layer}
            type="button"
            aria-pressed={activeLayers.includes(layer)}
            onClick={() => onToggleLayer(layer)}
            className={`${LAYER_BUTTON} ${activeLayers.includes(layer) ? LAYER_ON : LAYER_OFF}`}
          >
            {t(`layers.${layer}`)}
          </button>
        ))}
      </div>

      {(legendAccountTypes.length > 0 || legendHasScheduled) && (
        <ul
          className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:ml-auto"
          aria-label={t('legend.label')}
        >
          {legendAccountTypes.map((accountType) => (
            <li key={accountType} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block w-3 h-3 rounded-sm ${ACCOUNT_TYPE_META[accountType].pillClass}`}
              />
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {common(`accountTypes.${accountType}`)}
              </span>
            </li>
          ))}
          {legendHasScheduled && (
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block w-3 h-3 rounded-sm border border-dashed border-current ${SCHEDULED_KIND_CHIP_CLASSES.bill}`}
              />
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {t('legend.scheduled')}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
