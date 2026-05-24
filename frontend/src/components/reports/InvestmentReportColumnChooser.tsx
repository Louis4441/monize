'use client';

import { useMemo } from 'react';
import {
  INVESTMENT_REPORT_COLUMNS,
  INVESTMENT_COLUMN_MAP,
  ALWAYS_INCLUDED_COLUMN,
} from '@/types/investment-report';

interface InvestmentReportColumnChooserProps {
  /** Ordered selected column keys (symbol is forced to the front). */
  value: string[];
  onChange: (columns: string[]) => void;
}

/**
 * Lets the user pick which MS Money-style columns appear in the report and the
 * order they appear in. The symbol column is always present and pinned first.
 */
export function InvestmentReportColumnChooser({
  value,
  onChange,
}: InvestmentReportColumnChooserProps) {
  const selected = useMemo(() => {
    const rest = value.filter((c) => c !== ALWAYS_INCLUDED_COLUMN);
    return [ALWAYS_INCLUDED_COLUMN, ...rest];
  }, [value]);

  const available = useMemo(
    () => INVESTMENT_REPORT_COLUMNS.filter((c) => !selected.includes(c.key)),
    [selected],
  );

  const add = (key: string) => onChange([...selected, key]);
  const remove = (key: string) =>
    onChange(selected.filter((c) => c !== key));

  // Reordering never touches the pinned symbol at index 0.
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (index <= 0 || target <= 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Selected (ordered) */}
      <div>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Selected columns ({selected.length})
        </div>
        <ul className="border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-auto">
          {selected.map((key, index) => {
            const col = INVESTMENT_COLUMN_MAP[key];
            const locked = key === ALWAYS_INCLUDED_COLUMN;
            return (
              <li
                key={key}
                className="flex items-center gap-2 px-3 py-2 text-sm"
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    aria-label={`Move ${col?.label} up`}
                    disabled={index <= 1}
                    onClick={() => move(index, -1)}
                    className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed leading-none"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${col?.label} down`}
                    disabled={locked || index >= selected.length - 1}
                    onClick={() => move(index, 1)}
                    className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed leading-none"
                  >
                    ▼
                  </button>
                </div>
                <span className="flex-1 text-gray-900 dark:text-gray-100">
                  {col?.label ?? key}
                  {locked && (
                    <span className="ml-2 text-xs text-gray-400">(always shown)</span>
                  )}
                </span>
                {!locked && (
                  <button
                    type="button"
                    aria-label={`Remove ${col?.label}`}
                    onClick={() => remove(key)}
                    className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Available */}
      <div>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Available columns ({available.length})
        </div>
        <ul className="border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-auto">
          {available.length === 0 && (
            <li className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
              All columns selected
            </li>
          )}
          {available.map((col) => (
            <li key={col.key} className="flex items-start gap-2 px-3 py-2 text-sm">
              <button
                type="button"
                aria-label={`Add ${col.label}`}
                onClick={() => add(col.key)}
                className="mt-0.5 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium leading-none"
              >
                +
              </button>
              <div className="flex-1">
                <div className="text-gray-900 dark:text-gray-100">{col.label}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {col.description}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
