'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { Payee } from '@/types/payee';

interface PayeeSwitcherProps {
  /** The payee currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Payees to switch between. Empty until the list has loaded. */
  payees: readonly Payee[];
  onSelect: (id: string) => void;
}

/** Beyond this many, scanning the list is slower than typing into the filter. */
const FILTER_THRESHOLD = 8;

/**
 * A caret beside the payee's name that jumps straight to another one, without
 * going back to the list and clicking again. Same behaviour as the security
 * detail page's SecuritySwitcher: filter box above a threshold, close on
 * click-outside, Escape returns focus to the caret.
 */
export function PayeeSwitcher({ currentId, payees, onSelect }: PayeeSwitcherProps) {
  const t = useTranslations('payeeDetail');
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
    () => payees.filter((payee) => payee.id !== currentId),
    [payees, currentId],
  );

  const showFilter = others.length > FILTER_THRESHOLD;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return others;
    return others.filter((payee) => payee.name.toLowerCase().includes(needle));
  }, [others, query]);

  // Nothing to switch to: the caret would open an empty list.
  if (others.length === 0) return null;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t('header.switchPayee')}
        title={t('header.switchPayee')}
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
          aria-label={t('header.switchPayee')}
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
              matches.map((payee) => (
                <button
                  key={payee.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onSelect(payee.id);
                  }}
                  className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {payee.name}
                  </span>
                  {payee.defaultCategory?.name && (
                    <span className="ml-auto shrink-0 text-xs text-gray-500 dark:text-gray-400">
                      {payee.defaultCategory.name}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
