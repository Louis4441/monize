'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, re-read on an interval.
 *
 * For anything whose correctness depends on the clock rather than on data --
 * a market open/closed badge is the case this exists for. Without it the badge
 * shows whatever was true when the page mounted and stays wrong until
 * something unrelated causes a re-render.
 *
 * The default minute cadence is chosen for that use: it is the resolution the
 * answer actually has, and a second-by-second tick would re-render the tree
 * sixty times as often to display the same word.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
