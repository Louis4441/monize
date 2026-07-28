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
    resolveTourRequirements().then((resolved) => {
      if (!cancelled) setRequirements(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, requirements]);

  return requirements;
}
