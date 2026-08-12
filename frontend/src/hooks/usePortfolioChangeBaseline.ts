import { useEffect, useState } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import {
  PriorCloseBaseline,
  buildPriorCloseKey,
  fetchPriorCloseBaseline,
  usesPriorCloseBaseline,
} from '@/components/investments/portfolio-change-baseline';

interface UsePortfolioChangeBaselineOptions {
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

interface PortfolioChangeBaselineResult {
  /**
   * Whether this chart's change is measured from a prior close. False when the
   * range measures from its first point regardless, or when the user's
   * `portfolioChangeBaseline` preference says `period_start`.
   */
  usesPriorClose: boolean;
  /**
   * The close itself, or null whenever it is not known *for the chart on
   * screen*: a chart with no data, a lookup still in flight, a failed lookup,
   * or `usesPriorClose` being false.
   */
  priorClose: PriorCloseBaseline | null;
}

/**
 * The baseline the Portfolio Value chart's Change / Change % are measured
 * from, for whichever of the two the user has chosen in Settings.
 *
 * Both halves of the answer come from here so they cannot disagree: a
 * component that read the preference itself and the close from somewhere else
 * could show a prior-close figure under a period-start setting for as long as
 * the two were out of step. The value carries the request that produced it, so
 * a baseline fetched for a previous range, account filter or currency can
 * never be paired with the current chart -- it simply stops matching and reads
 * as unknown.
 */
export function usePortfolioChangeBaseline({
  range,
  firstPointDate,
  accountIds,
  displayCurrency,
}: UsePortfolioChangeBaselineOptions): PortfolioChangeBaselineResult {
  const preference = usePreferencesStore(
    (state) => state.preferences?.portfolioChangeBaseline,
  );
  const usesPriorClose = usesPriorCloseBaseline(range, preference);
  const key =
    usesPriorClose && firstPointDate
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

  return {
    usesPriorClose,
    priorClose: loaded && loaded.key === key ? loaded : null,
  };
}
