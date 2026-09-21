'use client';

import { useEffect, useState } from 'react';
import { netWorthApi } from '@/lib/net-worth';
import { createLogger } from '@/lib/logger';
import {
  isoDatePart,
  previousCalendarDay,
  usesPriorCloseBaseline,
} from '@/components/investments/portfolio-change-baseline';
import { isPortfolioPeriodPreset } from '@/types/net-worth';
import type { PortfolioPeriodResult } from '@/types/net-worth';

const logger = createLogger('usePortfolioPeriodResult');

interface UsePortfolioPeriodResultOptions {
  /** The chart's active range preset ('1d', '1w', 'mtd', ...). */
  range: string;
  /** The window the series was requested for, as sent to its own endpoint. */
  startDate: string;
  endDate: string;
  /**
   * The point's own date/timestamp of the FIRST point on screen, or undefined
   * while the series is empty. Only a range the server has no preset for needs
   * it: there the client names the window, and a prior-close range measures
   * from the close before the session actually drawn.
   */
  firstPointIso?: string;
  /** Whether the series has any points at all. */
  hasSeries: boolean;
  /** Comma-separated account filter, as sent to the series endpoint. */
  accountIds?: string;
  /** Display currency override, as sent to the series endpoint. */
  displayCurrency?: string;
  /** Bumped by the surface when a write changed the rows behind the window. */
  reloadKey?: number;
}

interface UsePortfolioPeriodResultValue {
  /**
   * What the server says the portfolio did over the window, or null while it
   * has not answered for THIS request -- a load in flight, a failed request, or
   * a window with no series to measure. Null is never a period that did
   * nothing: nothing here subtracts, divides or falls back to the series.
   */
  periodResult: PortfolioPeriodResult | null;
}

/**
 * The period result for the window a portfolio series draws.
 *
 * **The window a price chart DRAWS is not the period its button names.**
 * `portfolio-range-window.ts` opens 3M a day early so the first plotted close
 * precedes the quarter, widens 1D to a week so a daily fallback has more than
 * one point, and leaves All with no start date at all. Those rules are right
 * for a line and wrong for a figure, and sending the drawn window to the
 * measurement endpoint is what made 1D report a week, 3M disagree with the
 * performance card beside it and All report nothing (issue #1424).
 *
 * So the window is NAMED rather than dated: the range goes out as `period` and
 * the server resolves it from `portfolio-period-presets.util.ts`, the same file
 * the batch route behind "Portfolio performance" resolves its windows from. Two
 * cards on one page cannot then disagree about where a quarter opens. A range
 * the server has no preset for (`mtd`, a custom window) still sends its own
 * dates, and `usesPriorCloseBaseline` still decides that it measures from the
 * close before the first point actually on screen.
 *
 * The payload is kept WITH the key of the request that produced it, so a range,
 * account or currency switch cannot leave the previous window's figures under
 * the new window's caption.
 */
export function usePortfolioPeriodResult({
  range,
  startDate,
  endDate,
  firstPointIso,
  hasSeries,
  accountIds,
  displayCurrency,
  reloadKey = 0,
}: UsePortfolioPeriodResultOptions): UsePortfolioPeriodResultValue {
  const period = isPortfolioPeriodPreset(range) ? range : undefined;
  const usesPriorClose = usesPriorCloseBaseline(range);
  const firstPointDate = isoDatePart(firstPointIso);
  const baselineDate =
    usesPriorClose && firstPointDate
      ? previousCalendarDay(firstPointDate)
      : undefined;
  // Everything the answer depends on. An answer is shown only under the key it
  // was asked for; anything else describes a different window.
  const key = JSON.stringify([
    period ?? null,
    startDate,
    endDate,
    baselineDate ?? null,
    accountIds ?? null,
    displayCurrency ?? null,
    usesPriorClose,
    reloadKey,
  ]);
  const [state, setState] = useState<{
    key: string;
    result: PortfolioPeriodResult;
  } | null>(null);

  useEffect(() => {
    // A named window needs nothing from the chart: the server knows where it
    // opens and what today is. A dated one waits for both.
    if (!period) {
      if (!hasSeries || !startDate) return;
      // A prior-close range measures from the close before the first point ON
      // SCREEN, so it waits for that point rather than guessing at a date.
      if (usesPriorClose && !baselineDate) return;
    }
    let cancelled = false;
    netWorthApi
      .getInvestmentsPeriodResult(
        period
          ? { period, accountIds, displayCurrency }
          : { startDate, endDate, baselineDate, accountIds, displayCurrency },
      )
      .then((result) => {
        if (!cancelled) setState({ key, result });
      })
      .catch((error) => {
        logger.error('Failed to load the period result:', error);
        // A failed request is not a period that did nothing: every figure stays
        // unknown until the server answers.
        if (!cancelled) {
          setState((prev) => (prev?.key === key ? null : prev));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    key,
    period,
    hasSeries,
    startDate,
    endDate,
    baselineDate,
    accountIds,
    displayCurrency,
    usesPriorClose,
  ]);

  return { periodResult: state?.key === key ? state.result : null };
}
