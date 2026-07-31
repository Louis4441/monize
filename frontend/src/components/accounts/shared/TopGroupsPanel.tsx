'use client';

import { useMemo, type ReactNode } from 'react';
import { chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { GroupedTotal } from '@/types/transaction';

interface TopGroupsPanelProps {
  title: string;
  /** Optional timeframe caption shown under the title (e.g. "This month"). */
  subtitle?: string;
  emptyLabel: string;
  fallbackLabel: string;
  totals: GroupedTotal[];
  currencyCode: string;
  isLoading: boolean;
  limit?: number;
  /** When set, each row becomes a link to its filtered transactions (id may be null). */
  onSelect?: (id: string | null) => void;
  /** Allow the unidentified (e.g. uncategorised) row to be selectable too. */
  selectableWhenUnidentified?: boolean;
  /**
   * Control rendered at the right of the heading row (e.g. a range toggle).
   * Omitted, the heading keeps the full width exactly as before.
   */
  headerAction?: ReactNode;
}

/**
 * A ranked list of grouped totals (top categories or payees) by magnitude, with
 * a proportional bar and sign-coloured amounts. Shared between the category and
 * payee breakdowns on the banking detail view.
 */
export function TopGroupsPanel({
  title,
  subtitle,
  emptyLabel,
  fallbackLabel,
  totals,
  currencyCode,
  isLoading,
  limit = 6,
  onSelect,
  selectableWhenUnidentified = false,
  headerAction,
}: TopGroupsPanelProps) {
  const { formatCurrency } = useNumberFormat();

  const rows = useMemo(() => {
    const ranked = [...totals]
      .filter((g) => Math.abs(Number(g.total) || 0) > 0)
      .sort((a, b) => Math.abs(Number(b.total)) - Math.abs(Number(a.total)))
      .slice(0, limit);
    const max = ranked.reduce((m, g) => Math.max(m, Math.abs(Number(g.total))), 0);
    return { ranked, max };
  }, [totals, limit]);

  return (
    <section>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-24 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : rows.ranked.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">{emptyLabel}</p>
        ) : (
          <ul className="space-y-3">
            {rows.ranked.map((g, i) => {
              const amount = Number(g.total) || 0;
              const clickable = !!onSelect && (g.id != null || selectableWhenUnidentified);
              // Colour carries the sign, but through the theme's chart tokens
              // rather than fixed Tailwind red/green: on a themed palette the
              // hardcoded shades are the only thing on the panel that ignores
              // the theme. Amount and bar share the one token so the row reads
              // as a single mark.
              const signColor = amount < 0 ? chartColors.expense : chartColors.income;
              const body = (
                <>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-gray-700 dark:text-gray-200 truncate">
                      {g.name ?? fallbackLabel}
                    </span>
                    <span
                      className="font-medium tabular-nums"
                      style={{ color: signColor }}
                    >
                      {formatCurrency(Math.abs(amount), currencyCode)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${rows.max > 0 ? (Math.abs(amount) / rows.max) * 100 : 0}%`,
                        backgroundColor: signColor,
                      }}
                    />
                  </div>
                </>
              );
              return (
                <li key={`${g.id ?? 'none'}-${i}`}>
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => onSelect!(g.id)}
                      className="block w-full text-left -mx-1 px-1 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      {body}
                    </button>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
