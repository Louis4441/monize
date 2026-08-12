import { useEffect, useState } from 'react';
import {
  PriorCloseBaseline,
  buildPriorCloseKey,
  fetchPriorCloseBaseline,
  usesPriorCloseBaseline,
} from '@/components/investments/portfolio-change-baseline';

interface UsePriorCloseBaselineOptions {
  /** The chart's active range preset ('1d', '1w', 'mtd', ...). */
  range: string;
  /**
   * Date (YYYY-MM-DD) of the first point currently plotted, or null when the
   * chart has no data yet. Driving the lookup off what is on screen -- rather
   * than off the requested window -- keeps the baseline correct when the
   * session shown is not today's (a weekend or a holiday).
   */
  firstPointDate: string | null;
  /** Comma-separated account filter, as sent to the chart's own endpoint. */
  accountIds?: string;
  /** Display currency override, as sent to the chart's own endpoint. */
  displayCurrency?: string;
}

/**
 * The portfolio's value at the close before the chart's first point, for the
 * ranges that measure their change from it (1D / 1W / MTD).
 *
 * Returns null whenever the baseline is not known *for the chart on screen*:
 * a range that does not use one, a chart with no data, a load still in flight,
 * or a failed lookup. The value carries the request that produced it, so a
 * baseline fetched for a previous range or account filter can never be paired
 * with the current chart -- it simply stops matching and reads as unknown.
 */
export function usePriorCloseBaseline({
  range,
  firstPointDate,
  accountIds,
  displayCurrency,
}: UsePriorCloseBaselineOptions): PriorCloseBaseline | null {
  const key =
    usesPriorCloseBaseline(range) && firstPointDate
      ? buildPriorCloseKey({ range, firstPointDate, accountIds, displayCurrency })
      : null;
  const [loaded, setLoaded] = useState<PriorCloseBaseline | null>(null);

  useEffect(() => {
    if (!key || !firstPointDate) return;
    let cancelled = false;
    void fetchPriorCloseBaseline({
      key,
      firstPointDate,
      accountIds,
      displayCurrency,
    }).then((result) => {
      // A failed or empty lookup leaves the previous value in place, where its
      // key no longer matches and it is therefore already unusable.
      if (!cancelled && result) setLoaded(result);
    });
    return () => {
      cancelled = true;
    };
  }, [key, firstPointDate, accountIds, displayCurrency]);

  return loaded && loaded.key === key ? loaded : null;
}
