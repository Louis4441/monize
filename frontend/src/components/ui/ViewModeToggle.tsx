'use client';

import { useTranslations } from 'next-intl';
import type { ViewMode } from '@/store/viewModeStore';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (view: ViewMode) => void;
}

/**
 * The segmented control that switches a screen between its table and its
 * month calendar.
 *
 * It wears `InvestmentViewToggle`'s chrome, deliberately: the two sit side by
 * side in the Investments toolbar, so a second styling of the same idea would
 * read as two different kinds of switch. Both take it from
 * `segmented-control.ts` rather than each spelling it out, which is how the
 * two last drifted apart.
 */
export function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
  const t = useTranslations('calendar');

  return (
    <div
      className={SEGMENTED_GROUP_CLASS}
      role="group"
      aria-label={t('view.label')}
    >
      <button
        type="button"
        onClick={() => onChange('table')}
        aria-pressed={value === 'table'}
        className={segmentClass(value === 'table')}
      >
        {t('view.table')}
      </button>
      <button
        type="button"
        onClick={() => onChange('calendar')}
        aria-pressed={value === 'calendar'}
        className={segmentClass(value === 'calendar')}
      >
        {t('view.calendar')}
      </button>
    </div>
  );
}
