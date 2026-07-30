'use client';

import { useEffect, useState } from 'react';
import {
  resolveTourRequirements,
  type TourRequirementMap,
} from '@/lib/tours/requirements';

/**
 * Resolve the tour data requirements once, for the surfaces that decide which
 * tours to offer.
 *
 * Fetches nothing unless asked (`enabled`), because most renders of those lists
 * contain no gated tour at all. Returns null until resolved, which callers read
 * as "not offerable yet" -- better than showing a row and pulling it away.
 */
export function useTourRequirements(enabled: boolean): TourRequirementMap | null {
  const [requirements, setRequirements] = useState<TourRequirementMap | null>(
    null,
  );

  useEffect(() => {
    if (!enabled || requirements !== null) return;
    let cancelled = false;
    // `resolveTourRequirements` swallows its own lookup failures, so this catch
    // is only for the unforeseeable. Left in because an unhandled rejection in
    // an effect surfaces as a page-level error, and the worst this hook is
    // allowed to do is leave a gated tour unoffered.
    resolveTourRequirements()
      .then((resolved) => {
        if (!cancelled) setRequirements(resolved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, requirements]);

  return requirements;
}
