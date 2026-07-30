import { ReactNode } from 'react';

export interface SummaryCardItem {
  /** Card label (e.g. "Current Balance"). */
  label: string;
  /** Primary value (already formatted). */
  value: ReactNode;
  /** Optional secondary line under the value. */
  note?: ReactNode;
  /** Tailwind text-colour classes for the value; defaults to neutral. */
  valueClass?: string;
  /** Accessible label override for the card article. Defaults to `label`. */
  ariaLabel?: string;
  /** When set, the card becomes a button (e.g. to drill into transactions). */
  onClick?: () => void;
  /**
   * Small decorative glyph shown before the label. Purely visual -- the label
   * already names the figure -- so it is hidden from assistive tech.
   */
  icon?: ReactNode;
  /**
   * Replaces the label/value/note body entirely, for a card that is a small
   * list rather than a single figure (the detail page's "Held in accounts").
   * The card keeps its shared chrome either way.
   */
  body?: ReactNode;
  /** Extra classes for this card, e.g. a wider `col-span` on desktop. */
  className?: string;
}

interface SummaryCardGridProps {
  cards: SummaryCardItem[];
  /**
   * Tailwind grid-column classes. Defaults to the loan detail page's 2/3/6
   * responsive layout; per-type views pass their own column counts.
   */
  className?: string;
}

/** Default responsive grid, matching the original loan summary card row. */
export const DEFAULT_SUMMARY_GRID = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4';

/**
 * A responsive row of key-figure cards (label / value / optional note),
 * generalised from `LoanSummaryCards` so every account detail view shares the
 * same card styling. Purely presentational -- callers format the values.
 */
export function SummaryCardGrid({ cards, className = DEFAULT_SUMMARY_GRID }: SummaryCardGridProps) {
  return (
    <div className={className}>
      {cards.map((card, index) => {
        const label = (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            {card.icon && (
              <span aria-hidden="true" className="shrink-0">
                {card.icon}
              </span>
            )}
            <span>{card.label}</span>
          </div>
        );
        const body = card.body ? (
          <>
            {label}
            {card.body}
          </>
        ) : (
          <>
            {label}
            <div className={`text-lg font-bold ${card.valueClass ?? 'text-gray-900 dark:text-gray-100'}`}>
              {card.value}
            </div>
            {card.note != null && card.note !== '' && (
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{card.note}</div>
            )}
          </>
        );
        const base = `bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 ${card.className ?? ''}`;
        return card.onClick ? (
          <button
            key={`${card.label}-${index}`}
            type="button"
            aria-label={card.ariaLabel ?? card.label}
            onClick={card.onClick}
            className={`${base} text-left w-full hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}
          >
            {body}
          </button>
        ) : (
          <article
            key={`${card.label}-${index}`}
            aria-label={card.ariaLabel ?? card.label}
            className={base}
          >
            {body}
          </article>
        );
      })}
    </div>
  );
}
