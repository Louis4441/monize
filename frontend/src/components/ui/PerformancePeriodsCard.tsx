'use client';

import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { gainLossColor } from '@/lib/format';

/** One period's row: a label, a figure, and optionally a figure beneath it. */
export interface PerformancePeriodEntry {
  /** Stable key for the row; the preset it was computed for. */
  period: string;
  /** What the reader sees on the left: "1M", "YTD". */
  label: string;
  /**
   * The headline figure, already formatted by whoever knows what it is. `null`
   * is a period that cannot be reported, and it reads as the unavailable label
   * rather than as a zero: a zero here would be a statement about performance
   * instead of about our data.
   */
  primary: string | null;
  /** The sign the headline is coloured by; no colour when it is absent. */
  primaryValue?: number | null;
  /** A second figure beneath the headline, in the same convention. */
  secondary?: string | null;
  secondaryValue?: number | null;
}

interface PerformancePeriodsCardProps {
  title: string;
  /** One line under the title saying what these figures measure. */
  subtitle?: string;
  entries: readonly PerformancePeriodEntry[];
  /** What a `null` figure reads as; each surface supplies its own catalog's. */
  unavailableLabel: string;
  /** Shown instead of the list when no period can be reported at all. */
  emptyMessage: string;
  /** A caption under the list: what the figures do and do not include. */
  footnote?: ReactNode;
  /** `warning` is for a footnote that qualifies the figures rather than explaining them. */
  footnoteTone?: 'muted' | 'warning';
  /** Title attribute for the footnote, where it has more to say. */
  footnoteTitle?: string;
  'data-testid'?: string;
}

/**
 * Figures over the standard trailing periods, in the one layout this app has
 * for them.
 *
 * Two surfaces ask the same question of different subjects -- what a security
 * did, and what the reader's portfolio earned -- and a reader moving between
 * them should not have to re-learn the table. Everything here is presentational:
 * the figures arrive formatted, "n/a" is a period the caller could not report,
 * and the only decision made here is the colour, which is `gainLossColor` over
 * the sign the caller passes beside each figure.
 */
export function PerformancePeriodsCard({
  title,
  subtitle,
  entries,
  unavailableLabel,
  emptyMessage,
  footnote,
  footnoteTone = 'muted',
  footnoteTitle,
  'data-testid': testId,
}: PerformancePeriodsCardProps) {
  const hasAny = entries.some((entry) => entry.primary !== null);

  const figureClass = (value: number | null | undefined, unavailable: boolean) =>
    unavailable || value === null || value === undefined
      ? 'text-gray-400 dark:text-gray-500'
      : gainLossColor(value);

  return (
    <Card className="flex h-full flex-col p-4" data-testid={testId}>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h3>
      {subtitle && (
        <p className="mb-3 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {subtitle}
        </p>
      )}
      {hasAny ? (
        <dl className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.period}
              className="flex items-baseline justify-between gap-4"
            >
              <dt className="text-sm text-gray-500 dark:text-gray-400">
                {entry.label}
              </dt>
              <dd className="text-right">
                <div
                  className={`text-sm font-medium tabular-nums ${figureClass(
                    entry.primaryValue,
                    entry.primary === null,
                  )}`}
                >
                  {entry.primary === null ? unavailableLabel : entry.primary}
                </div>
                {/* A second line only where the caller has one: a period with
                    no amount beneath it must not grow an empty row. */}
                {entry.secondary !== undefined && (
                  <div
                    className={`text-xs tabular-nums ${figureClass(
                      entry.secondaryValue,
                      entry.secondary === null,
                    )}`}
                  >
                    {entry.secondary === null
                      ? unavailableLabel
                      : entry.secondary}
                  </div>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {emptyMessage}
        </p>
      )}
      {hasAny && footnote && (
        <p
          className={`mt-3 text-xs ${
            footnoteTone === 'warning'
              ? 'text-amber-600 dark:text-amber-500'
              : 'text-gray-500 dark:text-gray-400'
          }`}
          title={footnoteTitle}
        >
          {footnote}
        </p>
      )}
    </Card>
  );
}
