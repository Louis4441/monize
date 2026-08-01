import { roundMoney, roundToDecimals, sumMoney } from "../common/round.util";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import {
  EMPTY_COMPOSITION,
  GemCompositionBasis,
  GemCompositionDimension,
  GemSecurityComposition,
  GemWeighting,
  dimensionFor,
  matchHolding,
  requiredDimensionFor,
} from "./gem-composition.util";

/**
 * Pure arithmetic for "where does the real portfolio stand versus the signal".
 * Given the strategy accounts' holdings already valued in one currency, it
 * produces the compliance figure and the cost estimates the report shows -- no
 * database, no currency conversion (the service does both before calling in).
 *
 * The comparison covers **everything** held in those accounts, not only the
 * instruments the strategy assigned to a role: GEM asks for the whole portfolio
 * to sit in one asset, so a holding outside the strategy is exactly what makes
 * the portfolio non-compliant and exactly what a switch has to move.
 */

/** One security's holding, summed across the strategy's accounts and valued. */
export interface GemHolding {
  /** Strategy role the security fills, or null when it fills none. */
  role: GemAssetRole | null;
  securityId: string;
  symbol: string | null;
  name: string | null;
  quantity: number;
  /** Market value in the report currency, or null when the security has no price. */
  marketValue: number | null;
  /** Cost basis in the report currency, or null when it is unknown. */
  costBasis: number | null;
  /** The security's stored breakdowns, for the composition comparison. */
  composition?: GemSecurityComposition;
}

/** A holding plus how much of it already sits in the target's markets. */
export interface GemMatchedHolding extends GemHolding {
  /** Share of this holding in the target's markets, 0-1. */
  overlap: number;
  /** True when the ticker was compared because no breakdown was available. */
  matchedByInstrument: boolean;
  /** Which markets that share is made of, largest first. */
  matchedMarkets: GemWeighting[];
}

export interface GemPositionMath {
  /** Holdings above the dust threshold, largest position first. */
  holdings: GemMatchedHolding[];
  /** The largest holding: what the accounts are effectively in. */
  current: GemMatchedHolding | null;
  /** Holdings a switch would sell into the target, largest first. */
  offTarget: GemMatchedHolding[];
  /** Whether contents or tickers decided the comparison. */
  basis: GemCompositionBasis;
  /** Breakdown the contents were compared on; null when tickers were used. */
  dimension: GemCompositionDimension | null;
  /**
   * The breakdown the target would need for a contents comparison of this
   * role -- what to fill in when `basis` is INSTRUMENT. Null with no target.
   */
  requiredDimension: GemCompositionDimension | null;
  /** Holdings that fell back to a ticker comparison for want of a breakdown. */
  instrumentMatchedCount: number;
  /** Sum of the market values that could be valued. */
  totalMarketValue: number | null;
  /** Share of `totalMarketValue` already in the target role, 0-100. */
  compliancePercent: number | null;
  changeRequired: boolean;
  /** Value held outside the target role -- what a switch would move. */
  transferValue: number | null;
  /** Gain (positive) or loss (negative) a switch would realize. */
  realizedGainLoss: number | null;
}

/**
 * Quantities below this are treated as no position: a residual fraction left by
 * a sale should not make the account look invested. Matches the dust threshold
 * the portfolio views use.
 */
const DUST_QUANTITY = 0.0001;

/** Fully-in-the-target tolerance: rounding should not read as non-compliant. */
const COMPLIANCE_TOLERANCE_PERCENT = 99.5;

export function buildPositionMath(
  holdings: GemHolding[],
  targetRole: GemAssetRole | null,
  /** The instrument the signal names, with the breakdowns it is described by. */
  target: {
    securityId: string | null;
    composition: GemSecurityComposition;
  } = { securityId: null, composition: EMPTY_COMPOSITION },
): GemPositionMath {
  const sized = holdings
    .filter(
      (holding) =>
        Number.isFinite(holding.quantity) &&
        Math.abs(holding.quantity) >= DUST_QUANTITY,
    )
    .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));

  // What the strategy is asking for is exposure to the target's markets, so the
  // comparison runs on the breakdown the target is described by. With no
  // description there is nothing to compare and every holding is judged by its
  // ticker, exactly as before.
  const dimension = dimensionFor(target.composition, targetRole);
  const valued: GemMatchedHolding[] = sized.map((holding) => {
    if (!targetRole) {
      return {
        ...holding,
        overlap: 0,
        matchedByInstrument: true,
        matchedMarkets: [],
      };
    }
    const match = matchHolding({
      // The role settles it as well as the id does, and keeps the fallback
      // identical to the comparison this report made before compositions.
      isTarget:
        holding.role === targetRole ||
        (target.securityId !== null &&
          holding.securityId === target.securityId),
      holding: holding.composition ?? EMPTY_COMPOSITION,
      target: target.composition,
      dimension,
    });
    return {
      ...holding,
      overlap: match.overlap,
      matchedByInstrument: match.byInstrument,
      matchedMarkets: match.matched,
    };
  });

  const knownValues = valued
    .map((holding) => holding.marketValue)
    .filter((value): value is number => value !== null);
  const totalMarketValue =
    knownValues.length > 0 ? sumMoney(knownValues) : null;

  const current = valued[0] ?? null;

  // Value already in the target's markets: a fund a tenth of which tracks them
  // contributes a tenth of itself, not nothing and not all of it.
  const targetValue = targetRole
    ? sumMoney(
        valued.map((holding) => (holding.marketValue ?? 0) * holding.overlap),
      )
    : 0;

  const compliancePercent =
    targetRole && totalMarketValue !== null && totalMarketValue > 0
      ? roundToDecimals((targetValue / totalMarketValue) * 100, 2)
      : null;

  // Anything not wholly inside the target's markets: a partial match is still
  // something a switch has to sell down, just not in full.
  const offTarget = targetRole
    ? valued.filter((holding) => holding.overlap < 1)
    : [];

  // With no target there is nothing to be compliant with. Otherwise a change is
  // needed when the portfolio is not fully in the target -- and when the values
  // are unknown, holding something else (or nothing) still settles it: what to
  // do does not depend on being able to price it.
  const changeRequired = targetRole
    ? compliancePercent === null
      ? valued.length === 0 || offTarget.length > 0
      : compliancePercent < COMPLIANCE_TOLERANCE_PERCENT
    : false;
  const offTargetValues = offTarget
    .map((holding) =>
      holding.marketValue === null
        ? null
        : holding.marketValue * (1 - holding.overlap),
    )
    .filter((value): value is number => value !== null);
  const transferValue =
    offTargetValues.length > 0 ? sumMoney(offTargetValues) : null;

  const realizable = offTarget.filter(
    (holding) => holding.marketValue !== null && holding.costBasis !== null,
  );
  // Only the part that moves is sold, so only that part realizes a result.
  const realizedGainLoss =
    realizable.length > 0
      ? sumMoney(
          realizable.map(
            (holding) =>
              ((holding.marketValue as number) -
                (holding.costBasis as number)) *
              (1 - holding.overlap),
          ),
        )
      : null;

  return {
    holdings: valued,
    current,
    offTarget,
    basis: dimension === null ? "INSTRUMENT" : "COMPOSITION",
    dimension,
    requiredDimension: requiredDimensionFor(targetRole),
    instrumentMatchedCount: valued.filter(
      (holding) => holding.matchedByInstrument,
    ).length,
    totalMarketValue,
    compliancePercent,
    changeRequired,
    transferValue,
    realizedGainLoss,
  };
}

/**
 * Tax on an estimated realized gain. A loss owes nothing, and without a
 * configured rate the estimate is unknown rather than zero.
 */
export function estimateTax(
  realizedGainLoss: number | null,
  taxRatePercent: number | null,
): number | null {
  if (realizedGainLoss === null || taxRatePercent === null) return null;
  if (realizedGainLoss <= 0) return 0;
  return roundMoney((realizedGainLoss * taxRatePercent) / 100);
}

/**
 * Commission the switch costs: the configured per-trade amount times the number
 * of trades it takes. Selling out of three instruments and buying one is four
 * trades, not one, so charging a single commission understated a switch out of
 * a spread-out portfolio by exactly the amount that makes switching expensive.
 *
 * A switch that sells nothing is the first purchase: one trade. Without a
 * configured commission the estimate stays unknown rather than becoming zero.
 */
export function estimateCommission(
  commissionAmount: number | null,
  sellCount: number,
): number | null {
  if (commissionAmount === null) return null;
  const trades = Math.max(0, sellCount) + 1;
  return roundMoney(commissionAmount * trades);
}
