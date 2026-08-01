'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export const GEM_TABS = ['overview', 'signals', 'portfolio', 'backtest', 'settings'] as const;

export type GemTab = (typeof GEM_TABS)[number];

interface GemStrategyTabsProps {
  active: GemTab;
  onChange: (tab: GemTab) => void;
}

/**
 * Tab bar for the strategy page. Follows the WAI-ARIA tabs pattern: a single
 * tab stop with Arrow/Home/End moving (and activating) the selection, so the
 * whole bar is reachable without a mouse. Scrolls horizontally on narrow
 * screens rather than wrapping or shrinking the labels.
 */
export function GemStrategyTabs({ active, onChange }: GemStrategyTabsProps) {
  const t = useTranslations('strategies');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number) => {
    const next = (index + GEM_TABS.length) % GEM_TABS.length;
    onChange(GEM_TABS[next]);
    tabRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(GEM_TABS.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={t('gem.tabs.ariaLabel')}
      className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-gray-200 px-4 dark:border-gray-700 sm:mx-0 sm:px-0"
    >
      {GEM_TABS.map((tab, index) => {
        const isActive = tab === active;
        return (
          <button
            key={tab}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            id={`gem-tab-${tab}`}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-controls={`gem-panel-${tab}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900',
              isActive
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200',
            )}
          >
            {t(`gem.tabs.${tab}` as Parameters<typeof t>[0])}
          </button>
        );
      })}
    </div>
  );
}
