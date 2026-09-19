/**
 * Whether the prices behind a portfolio value are evidence for the period being
 * measured, or carried from before it
 * (`docs/specs/portfolio-movement-notifications.md`, INV-PORTMOVE-008).
 *
 * Valuation legitimately carries a close forward: a position whose latest
 * accepted close is a month old is still worth that close today, and a manually
 * priced 401(k) depends on exactly that (`docs/time-series-contract.md` section
 * 2.1, second exception). A **movement** is a different question. It is a
 * difference of two dated observations, and a position priced before the
 * baseline date contributes the same carried figure to both ends -- until the
 * run in which its price arrives (or its row disappears), which books the whole
 * catch-up as one day's market move. That is the 94% "movement" in issue #1391.
 *
 * So this does not drop the position from the valuation and it does not
 * intersect the two runs' position sets; it reports that the run has no evidence
 * for the period, and the producer withholds and does not advance the baseline
 * (INV-PORTMOVE-001).
 */

/** Below this a quantity is a rounding artefact, not a position. */
const QUANTITY_EPSILON = 0.00000001;

/** A held position, as `getPortfolioSummary().holdings` reports one. */
export interface HeldPosition {
  securityId: string;
  quantity: number;
}

/**
 * The securities held in a non-zero quantity whose latest accepted close is
 * older than `notBefore` (or absent entirely), sorted and de-duplicated.
 *
 * `priceDateFor` answers with the `YYYY-MM-DD` date of the observation that
 * valued the position, from the same store the valuation read, or `null` when
 * there is none. An empty result means every held position was priced on or
 * after `notBefore`.
 */
export function stalePricedSecurityIds(
  positions: readonly HeldPosition[],
  priceDateFor: (securityId: string) => string | null,
  notBefore: string,
): string[] {
  const stale = new Set<string>();
  for (const { securityId, quantity } of positions) {
    if (Math.abs(quantity) < QUANTITY_EPSILON) continue;
    const priceDate = priceDateFor(securityId);
    if (priceDate === null || priceDate < notBefore) stale.add(securityId);
  }
  return [...stale].sort();
}
