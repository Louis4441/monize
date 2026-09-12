'use client';

import { useTranslations } from 'next-intl';
import type { ViewMode } from '@/store/viewModeStore';

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (view: ViewMode) => void;
}

const BUTTON_BASE = 'px-3 py-1 text-sm font-medium rounded transition-colors motion-reduce:transition-none';
const BUTTON_ACTIVE = 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm';
const BUTTON_INACTIVE =
  'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200';

/**
 * The segmented control that switches a screen between its table and its
 * month calendar.
 *
 * It is `InvestmentViewToggle`'s control, deliberately: the two sit side by
 * side in the Investments toolbar, so a second styling of the same idea would
 * read as two different kinds of switch.
 */
export function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
  const t = useTranslations('calendar');

  return (
    <div
      className="inline-flex rounded-md bg-gray-100 dark:bg-gray-700 p-0.5"
      role="group"
      aria-label={t('view.label')}
    >
      <button
        type="button"
        onClick={() => onChange('table')}
        aria-pressed={value === 'table'}
        className={`${BUTTON_BASE} ${value === 'table' ? BUTTON_ACTIVE : BUTTON_INACTIVE}`}
      >
        {t('view.table')}
      </button>
      <button
        type="button"
        onClick={() => onChange('calendar')}
        aria-pressed={value === 'calendar'}
        className={`${BUTTON_BASE} ${value === 'calendar' ? BUTTON_ACTIVE : BUTTON_INACTIVE}`}
      >
        {t('view.calendar')}
      </button>
    </div>
  );
}
