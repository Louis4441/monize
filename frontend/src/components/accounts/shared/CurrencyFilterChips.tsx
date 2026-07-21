'use client';

import { useTranslations } from 'next-intl';

interface CurrencyFilterChipsProps {
  /** Currently selected paid-currency codes. */
  selected: string[];
  /** Called with the remaining codes when a chip is removed. */
  onChange: (next: string[]) => void;
}

/**
 * Removable pills for the active foreign-currency filter, matching the
 * filter-chip style used elsewhere (e.g. the Transactions filter panel).
 * Renders nothing when no currency is selected.
 */
export function CurrencyFilterChips({ selected, onChange }: CurrencyFilterChipsProps) {
  const t = useTranslations('accountDetail-fxFees');
  if (selected.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {selected.map((code) => (
        <span
          key={code}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 whitespace-nowrap"
        >
          {code}
          <button
            type="button"
            onClick={() => onChange(selected.filter((c) => c !== code))}
            className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-blue-200 dark:hover:bg-blue-800"
            aria-label={t('currencyFilter.remove', { code })}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}
