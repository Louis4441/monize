'use client';

import { useEffect, useState } from 'react';
import { netWorthApi } from '@/lib/net-worth';
import { createLogger } from '@/lib/logger';
import {
  isoDatePart,
  previousCalendarDay,
  usesPriorCloseBaseline,
} from '@/components/investments/portfolio-change-baseline';
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
   * while the series is empty. A prior-close range measures from the close
   * before the session actually drawn, not before the window asked for.
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
  /** Whether this range reports against the previous trading day's close. */
  usesPriorClose: boolean;
}

/**
 * The period result for the window a portfolio series draws.
 *
 * The client picks the dates and the server measures: a change derived from the
 * plotted series counts the reader's own deposits as performance, which is the
 * defect INV-PORTRESULT-001 exists to stop. `usesPriorCloseBaseline` and
 * `previousCalendarDay` still decide that 1d, 1w and mtd report against the
 * previous close, and that date goes out as `baselineDate`.
 *
 * The payload is kept WITH the key of the request that produced it, so a range,
 * account or currency switch cannot leave the previous window's figures under
 * the new window's caption, and a request that is never made (a prior-close
 * range with nothing on screen yet) leaves the figures unknown rather than
 * stale.
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
  const usesPriorClose = usesPriorCloseBaseline(range);
  const firstPointDate = isoDatePart(firstPointIso);
  const baselineDate =
    usesPriorClose && firstPointDate
      ? previousCalendarDay(firstPointDate)
      : undefined;
  // Everything the answer depends on. An answer is shown only under the key it
  // was asked for; anything else describes a different window.
  const key = JSON.stringify([
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
    if (!hasSeries || !startDate) return;
    // A prior-close range measures from the close before the first point ON
    // SCREEN, so it waits for that point rather than guessing at a date.
    if (usesPriorClose && !baselineDate) return;
    let cancelled = false;
    netWorthApi
      .getInvestmentsPeriodResult({
        startDate,
        endDate,
        baselineDate,
        accountIds,
        displayCurrency,
      })
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
    hasSeries,
    startDate,
    endDate,
    baselineDate,
    accountIds,
    displayCurrency,
    usesPriorClose,
  ]);

  return {
    periodResult: state?.key === key ? state.result : null,
    usesPriorClose,
  };
}
