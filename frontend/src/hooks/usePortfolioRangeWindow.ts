'use client';

import { useEffect, useMemo, useState } from 'react';
import { netWorthApi } from '@/lib/net-worth';
import { createLogger } from '@/lib/logger';
import {
  applyPortfolioWindowStart,
  needsFirstPricedDay,
  startOfYearIso,
} from '@/components/investments/portfolio-range-window';

const logger = createLogger('PortfolioRangeWindow');

/**
 * The window a Portfolio Value chart requests, with YTD's trading-day lookup
 * folded in.
 *
 * One hook rather than the rule in one place and the lookup in another, for the
 * same reason `usePortfolioChangeBaseline` is one hook: while the two are out
 * of step the chart draws a window under a rule it is not actually using, and
 * nothing about it looks wrong.
 *
 * **The lookup carries the request that produced it.** A first-priced day
 * fetched for one account selection says nothing about another, so it is stored
 * with its key and read only while that key still matches -- a late response
 * for the previous selection is discarded rather than moving the window of the
 * chart now on screen.
 *
 * While YTD's lookup is in flight the window keeps its calendar boundary, so
 * the chart draws from 1 January and then tightens to the first trading day.
 * That is one extra render of a slightly wider window, never a wrong number:
 * every point plotted is a real close either way.
 */
export function usePortfolioRangeWindow(params: {
  range: string;
  /** The window as `useDateRange`/`resolveRangePreset` resolved it. */
  base: { start: string; end: string };
  accountIdsCsv?: string;
  /** Injectable "now", for deterministic tests. */
  now?: Date;
}): { start: string; end: string } {
  const { range, base, accountIdsCsv, now } = params;
  const wantsLookup = needsFirstPricedDay(range);
  const onOrAfter = useMemo(
    () => (wantsLookup ? startOfYearIso(now ?? new Date()) : ''),
    // `now` is a stable injectable in tests and undefined in the app, where
    // the year cannot change under a mounted chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wantsLookup, now?.getTime()],
  );
  const key = `${onOrAfter}|${accountIdsCsv ?? ''}`;
  const [resolved, setResolved] = useState<{
    key: string;
    date: string | null;
  } | null>(null);

  useEffect(() => {
    if (!wantsLookup) return;
    let cancelled = false;
    netWorthApi
      .getFirstPricedDay({ onOrAfter, accountIds: accountIdsCsv })
      .then(({ date }) => {
        if (!cancelled) setResolved({ key, date });
      })
      .catch((error) => {
        // Unknown, not "no trading days": the window keeps its calendar
        // boundary, which is the behaviour this replaced.
        logger.error('Failed to resolve the first priced day:', error);
        if (!cancelled) setResolved({ key, date: null });
      });
    return () => {
      cancelled = true;
    };
  }, [wantsLookup, onOrAfter, accountIdsCsv, key]);

  return useMemo(
    () =>
      applyPortfolioWindowStart(range, base, {
        now,
        ytdFirstPricedDay: resolved?.key === key ? resolved.date : null,
      }),
    [range, base, now, resolved, key],
  );
}
