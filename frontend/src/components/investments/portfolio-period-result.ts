import type { PeriodResultReason } from '@/types/net-worth';

/**
 * Which repair a withheld period figure points the reader at.
 *
 * The marker carries one `UnknownAmount` cause and the server sends five, so
 * the mapping is made here rather than guessed -- the same decision
 * `movementUnknownReason` makes for a day's movement, for the same reason: an
 * unpriced holding is a price to add, a cash account with no balance is neither
 * a price nor a rate, an unconvertible amount is a rate to refresh, and a
 * boundary is nothing anybody can fix. Naming a price for a missing display
 * rate sends the reader to a screen where there is nothing to do.
 *
 * `zeroStart` and `noValueSeries` are both boundaries: a period that started at
 * nothing has no percentage to report, and a scope that produced no valued day
 * has nothing to compare. Neither is a defect to repair.
 */
export function periodResultUnknownReason(
  reasons: readonly PeriodResultReason[],
): 'noPrice' | 'displayFx' | 'noBaseline' | 'noCashBalance' {
  if (reasons.includes('incompletePrices')) return 'noPrice';
  if (reasons.includes('incompleteCash')) return 'noCashBalance';
  if (reasons.includes('missingRatePairs')) return 'displayFx';
  return 'noBaseline';
}
