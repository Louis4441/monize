'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { Security } from '@/types/investment';

interface SecuritySwitcherProps {
  /** The security currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Securities to switch between. Empty until the list has loaded. */
  securities: readonly Security[];
  onSelect: (id: string) => void;
}

/** Beyond this many, scanning the list is slower than typing into the filter. */
const FILTER_THRESHOLD = 8;

/**
 * A caret beside the security's name that jumps straight to another one,
 * without going back to the list and picking Details again.
 *
 * The filter appears only once the list is long enough to need it: for a handful
 * of securities the box is one more thing to skip past, and for a hundred it is
 * the only way through. Closes on click-outside and on Escape, which returns
 * focus to the caret -- the same behaviour as the app's other header menus.
 */
export function SecuritySwitcher({
  currentId,
  securities,
  onSelect,
}: SecuritySwitcherProps) {
  const t = useTranslations('securityDetail');
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setIsOpen(false);
    setQuery('');
  };

  useClickOutside(containerRef, close, {
    enabled: isOpen,
    onEscape: () => {
      close();
      triggerRef.current?.focus();
    },
  });

  const others = useMemo(
    () => securities.filter((security) => security.id !== currentId),
    [securities, currentId],
  );

  const showFilter = others.length > FILTER_THRESHOLD;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return others;
    return others.filter(
      (security) =>
        security.symbol.toLowerCase().includes(needle) ||
        security.name.toLowerCase().includes(needle),
    );
  }, [others, query]);

  // Nothing to switch to: the caret would open an empty list.
  if (others.length === 0) return null;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        // Closing goes through `close()` so the filter is cleared with it.
        // Toggling `isOpen` alone left the query behind, and reopening then
        // showed the previous search instead of the list -- which reads as most
        // of the securities having disappeared.
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t('header.switchSecurity')}
        title={t('header.switchSecurity')}
        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-700 dark:hover:text-gray-200"
      >
        <ChevronDownIcon
          className={`h-5 w-5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label={t('header.switchSecurity')}
          className="absolute left-0 z-50 mt-1 w-72 rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {showFilter && (
            <div className="border-b border-gray-200 p-2 dark:border-gray-700">
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('header.switchPlaceholder')}
                aria-label={t('header.switchPlaceholder')}
                autoFocus
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          )}
          <div className="max-h-72 overflow-y-auto py-1">
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {t('header.switchNoMatches')}
              </p>
            ) : (
              matches.map((security) => (
                <button
                  key={security.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onSelect(security.id);
                  }}
                  className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <span className="shrink-0 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {security.symbol}
                  </span>
                  <span className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {security.name}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
