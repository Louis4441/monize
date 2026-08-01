import { roundToDecimals } from "../common/round.util";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";

/**
 * How much of a holding already sits in the markets the strategy's target is
 * made of.
 *
 * The signal names one instrument, but what the strategy is actually asking for
 * is exposure to a market. A portfolio holding a world tracker is not "0% in
 * emerging markets" merely because the ticker differs from the target's -- part
 * of it already is, and only the rest has to move. Monize lets a security be
 * described by country, asset class and sector weightings, so when the target
 * carries that description the comparison is made against the contents rather
 * than against the ticker.
 *
 * Without that description there is nothing to compare, and the report falls
 * back to matching the instrument itself and says so. Guessing an overlap from
 * a fund's name would be a number the user could act on with no basis.
 */

/** The three breakdowns `securities` stores. */
export const GEM_COMPOSITION_DIMENSIONS = [
  "COUNTRY",
  "ASSET_CLASS",
  "SECTOR",
] as const;

export type GemCompositionDimension =
  (typeof GEM_COMPOSITION_DIMENSIONS)[number];

/**
 * Which breakdowns may decide a role's comparison, best first.
 *
 * Not every breakdown is a sound yardstick, and the wrong one produces
 * confident nonsense rather than a rough answer:
 *
 *   * The equity roles *are* geographies -- "US", "developed ex-US",
 *     "emerging" -- so only country can tell them apart. Asset class would
 *     call an S&P 500 fund and an emerging-markets fund a 100% match, since
 *     both are entirely stocks, and report a portfolio in exactly the wrong
 *     market as fully compliant. Sector is nearly as bad: both hold about a
 *     quarter technology, so it invents overlap out of a coincidence.
 *   * The defensive roles turn on asset class -- bonds against equities is
 *     the distinction that matters -- with country as a secondary check.
 *
 * Sector never decides anything. Two funds sharing a sector profile is not
 * evidence that they hold the same market, which is the only question GEM
 * asks. A role whose permitted breakdowns are all missing falls back to
 * matching the instrument itself, which is honest about knowing nothing.
 */
const DIMENSIONS_BY_ROLE: Record<GemAssetRole, GemCompositionDimension[]> = {
  US_EQUITY: ["COUNTRY"],
  EX_US_EQUITY: ["COUNTRY"],
  EM_EQUITY: ["COUNTRY"],
  SAFE: ["ASSET_CLASS", "COUNTRY"],
  RISK_FREE: ["ASSET_CLASS", "COUNTRY"],
};

/** How the report decided whether a holding counts towards the target. */
export type GemCompositionBasis = "COMPOSITION" | "INSTRUMENT";

/** A stored weighting row. Weights are decimals 0-1 and may sum to under 1. */
export interface GemWeighting {
  name: string;
  weight: number;
}

/** Every breakdown a security carries, as stored. */
export interface GemSecurityComposition {
  COUNTRY: GemWeighting[] | null;
  ASSET_CLASS: GemWeighting[] | null;
  SECTOR: GemWeighting[] | null;
}

export const EMPTY_COMPOSITION: GemSecurityComposition = {
  COUNTRY: null,
  ASSET_CLASS: null,
  SECTOR: null,
};

/**
 * Names for the same thing that this codebase itself produces differently.
 *
 * The asset-class column is filled from two places: the allocation editor,
 * where the user types whatever they like, and Yahoo, which writes "Stocks",
 * "Bonds", "Cash". A user who typed "Equities" against a fund and let the
 * provider fill the next one gets two descriptions that share no name at all,
 * and the comparison then reports a confident zero overlap between two bond
 * funds. Folding the English synonyms together fixes the collision we create.
 *
 * A name in another language is a different problem and is not solved here:
 * "Obligacje" against "Bonds" still shares nothing, which the report says out
 * loud rather than guessing -- it tells the user to check the two spellings
 * match instead of inventing an overlap.
 */
const NAME_SYNONYMS: Record<string, string> = {
  stock: "stocks",
  equity: "stocks",
  equities: "stocks",
  bond: "bonds",
  "fixed income": "bonds",
  "cash and equivalents": "cash",
  "cash equivalents": "cash",
  preferreds: "preferred",
  convertibles: "convertible",
  "united states of america": "united states",
  usa: "united states",
  us: "united states",
  // Punctuation is stripped before the lookup, so "U.S." arrives spaced out.
  "u s": "united states",
  "u s a": "united states",
  uk: "united kingdom",
  "u k": "united kingdom",
};

/**
 * One breakdown row's name, reduced to a comparable key: case, accents,
 * punctuation and "&"/"and" are noise that two people describing the same
 * market will differ on, and none of them carry meaning here.
 */
export function canonicalName(name: string): string {
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return NAME_SYNONYMS[normalized] ?? normalized;
}

/**
 * Weights keyed by canonical name (see `canonicalName`). Rows are summed rather
 * than overwritten so a breakdown that lists a name twice is not silently
 * reduced to its last entry, and the total is capped at 1: a description adding
 * up to more than the whole fund cannot buy extra overlap.
 */
export function weightsByName(
  entries: GemWeighting[] | null | undefined,
): Map<string, number> {
  const weights = new Map<string, number>();
  if (!entries) return weights;
  for (const entry of entries) {
    const name = entry?.name ? canonicalName(entry.name) : "";
    const weight = Number(entry?.weight);
    if (!name || !Number.isFinite(weight) || weight <= 0) continue;
    weights.set(name, (weights.get(name) ?? 0) + weight);
  }
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  if (total > 1) {
    for (const [name, weight] of weights) weights.set(name, weight / total);
  }
  return weights;
}

/** True when a breakdown says anything at all. */
export function hasWeightings(
  entries: GemWeighting[] | null | undefined,
): boolean {
  return weightsByName(entries).size > 0;
}

/**
 * The breakdown the target would have to carry for this role to be compared on
 * contents at all -- the best one the role permits. This is what the report
 * tells the user to fill in, and for an equity role it is country and nothing
 * else, so naming the three columns generically would send them to fill in one
 * that cannot help.
 */
export function requiredDimensionFor(
  role: GemAssetRole | null,
): GemCompositionDimension | null {
  return role ? (DIMENSIONS_BY_ROLE[role][0] ?? null) : null;
}

/**
 * The breakdown the comparison runs on: the best one the target describes that
 * is sound for the role being filled (see `DIMENSIONS_BY_ROLE`). Null when the
 * target describes none of them, or when the only breakdowns it has are ones
 * that cannot tell this role's markets apart.
 */
export function dimensionFor(
  target: GemSecurityComposition,
  role: GemAssetRole | null,
): GemCompositionDimension | null {
  if (!role) return null;
  return (
    DIMENSIONS_BY_ROLE[role].find((dimension) =>
      hasWeightings(target[dimension]),
    ) ?? null
  );
}

/**
 * Share of `holding` that lies in the same markets as `target`, 0-1.
 *
 * The overlap of two distributions is the sum of their per-name minimums: a
 * fund 10% in emerging markets overlaps an all-EM target by 0.1, and two
 * identical funds by 1. Weight a breakdown does not account for (a description
 * summing to less than 1) contributes nothing, because what it holds is
 * unknown, not known to match.
 */
export function compositionOverlap(
  holding: GemWeighting[] | null | undefined,
  target: GemWeighting[] | null | undefined,
): number {
  return overlapContributions(holding, target).reduce(
    (total, entry) => Math.min(1, total + entry.weight),
    0,
  );
}

/**
 * The overlap broken down by name, largest first: which markets the holding
 * shares with the target, and how much of the holding each accounts for.
 *
 * This is what the report shows when it explains a compliance figure. A single
 * percentage says a fifth of the fund is on target; this says which fifth.
 */
export function overlapContributions(
  holding: GemWeighting[] | null | undefined,
  target: GemWeighting[] | null | undefined,
): GemWeighting[] {
  const holdingWeights = weightsByName(holding);
  const targetWeights = weightsByName(target);
  if (holdingWeights.size === 0 || targetWeights.size === 0) return [];
  // Names are matched on the canonical key -- lowercased, with synonyms folded
  // together -- but that key is a comparison device, not a label. Pushing it
  // out put "united states 60%" on screen for a holding that says "United
  // States", and for a target that says "USA" it renamed the market entirely.
  const displayNames = new Map<string, string>();
  for (const entry of holding ?? []) {
    if (!entry?.name) continue;
    const key = canonicalName(entry.name);
    if (key && !displayNames.has(key)) displayNames.set(key, entry.name);
  }
  const contributions: GemWeighting[] = [];
  for (const [name, weight] of holdingWeights) {
    const targetWeight = targetWeights.get(name);
    if (targetWeight === undefined) continue;
    contributions.push({
      name: displayNames.get(name) ?? name,
      weight: Math.min(weight, targetWeight),
    });
  }
  return contributions.sort((a, b) => b.weight - a.weight);
}

/** One holding's verdict: how much of it counts, and how that was decided. */
export interface GemHoldingMatch {
  /** Share of the holding already in the target's markets, 0-1. */
  overlap: number;
  /** True when the ticker was compared because no breakdown was available. */
  byInstrument: boolean;
  /**
   * Which markets the overlap is made of, largest first. Empty when the ticker
   * decided it, or when the two breakdowns share nothing.
   */
  matched: GemWeighting[];
}

/**
 * How much of one holding counts towards the target.
 *
 * A holding the chosen breakdown does not describe is compared the old way --
 * it either is the target instrument or it is not -- rather than being scored
 * zero for missing data. Mixing the two within one report is deliberate: a
 * described holding gets the better answer, and an undescribed one gets the
 * answer the report gave before, never a worse one.
 */
export function matchHolding(params: {
  /** Whether this holding already is the instrument the signal names. */
  isTarget: boolean;
  holding: GemSecurityComposition;
  target: GemSecurityComposition;
  dimension: GemCompositionDimension | null;
}): GemHoldingMatch {
  const { isTarget, holding, target, dimension } = params;

  if (dimension === null || !hasWeightings(holding[dimension])) {
    return { overlap: isTarget ? 1 : 0, byInstrument: true, matched: [] };
  }
  // The target instrument counts in full even when its own breakdown is
  // partial: holding exactly what was asked for is complete by definition.
  if (isTarget) {
    return {
      overlap: 1,
      byInstrument: false,
      matched: overlapContributions(holding[dimension], target[dimension]),
    };
  }
  const matched = overlapContributions(holding[dimension], target[dimension]);
  return {
    overlap: compositionOverlap(holding[dimension], target[dimension]),
    byInstrument: false,
    matched,
  };
}

/** An overlap as a percentage for display, or null when there is nothing to say. */
export function overlapPercent(overlap: number | null): number | null {
  return overlap === null ? null : roundToDecimals(overlap * 100, 2);
}
