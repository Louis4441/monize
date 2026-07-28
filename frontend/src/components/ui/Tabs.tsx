'use client';

import { KeyboardEvent, useCallback, useRef } from 'react';

export interface TabItem<K extends string = string> {
  /** Stable identifier, also used to build the aria ids. */
  key: K;
  label: string;
}

interface TabsProps<K extends string> {
  tabs: readonly TabItem<K>[];
  /** The selected tab's key. */
  value: K;
  onChange: (key: K) => void;
  /**
   * Namespace for the generated `id`s, so two tab sets on one page keep their
   * `aria-controls` / `aria-labelledby` pairs distinct.
   */
  idPrefix: string;
  /** Names the tab set for screen readers. */
  ariaLabel: string;
  className?: string;
}

/** The id of a tab button, so a panel can point back at it. */
export function tabId(idPrefix: string, key: string): string {
  return `${idPrefix}-tab-${key}`;
}

/** The id of a tab's panel, so the button can point at it. */
export function tabPanelId(idPrefix: string, key: string): string {
  return `${idPrefix}-panel-${key}`;
}

/**
 * The app's tab bar: an underlined row of tabs, styled exactly like the two
 * hand-rolled tablists it generalises (`DelegateAccessModal`,
 * `ScheduledTransactionForm`), so nothing changes visually.
 *
 * What it adds over those two is the keyboard behaviour the ARIA tabs pattern
 * expects and neither had: one tab stop for the whole set (roving tabindex),
 * arrow keys to move between tabs, Home/End to jump to the ends. Selection
 * follows focus, which is the right choice here because switching a panel is
 * cheap and has no side effects.
 *
 * The row scrolls horizontally on its own when the tabs outgrow the viewport,
 * so a narrow screen never widens the page itself.
 */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  idPrefix,
  ariaLabel,
  className = '',
}: TabsProps<K>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectAt = useCallback(
    (index: number) => {
      // Wrap around both ends, as the tabs pattern specifies.
      const wrapped = (index + tabs.length) % tabs.length;
      const next = tabs[wrapped];
      if (!next) return;
      onChange(next.key);
      buttonRefs.current[wrapped]?.focus();
    },
    [onChange, tabs],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          selectAt(index + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          selectAt(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          selectAt(0);
          break;
        case 'End':
          event.preventDefault();
          selectAt(tabs.length - 1);
          break;
        default:
          break;
      }
    },
    [selectAt, tabs.length],
  );

  return (
    // The scroll lives on a wrapper, not on the tablist, and it carries `pb-px`
    // to absorb the 1px the active tab's `-mb-px` overhangs by. Without that
    // padding, setting overflow-x makes the browser compute overflow-y to `auto`
    // as well, and that 1px of vertical overflow draws a stray vertical
    // scrollbar beside the tabs.
    <div className={`overflow-x-auto pb-px ${className}`}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex gap-1 border-b border-gray-200 dark:border-gray-700"
      >
        {tabs.map((tab, index) => {
          const isSelected = tab.key === value;
          return (
            <button
              key={tab.key}
              ref={(element) => {
                buttonRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={tabId(idPrefix, tab.key)}
              aria-selected={isSelected}
              // Only the selected tab's panel is in the DOM (see TabPanel), and
              // aria-controls must not point at an element that is not there.
              aria-controls={
                isSelected ? tabPanelId(idPrefix, tab.key) : undefined
              }
              // One tab stop for the set: Tab reaches the selected tab, then
              // moves on into the panel rather than through every other tab.
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                isSelected
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface TabPanelProps {
  /** Must match the `idPrefix` given to the `Tabs` it belongs to. */
  idPrefix: string;
  /** The key of the tab this panel belongs to. */
  tabKey: string;
  /** Rendered only when this panel's tab is the selected one. */
  isActive: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * The panel half of the pair. Kept in the DOM only while active: the panels on
 * the security detail page each load their own data, so mounting the inactive
 * ones would fire requests for tabs nobody opened.
 */
export function TabPanel({
  idPrefix,
  tabKey,
  isActive,
  children,
  className = '',
}: TabPanelProps) {
  if (!isActive) return null;
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idPrefix, tabKey)}
      aria-labelledby={tabId(idPrefix, tabKey)}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}
