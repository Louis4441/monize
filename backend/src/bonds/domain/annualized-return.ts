import { ExactDecimal } from "./exact-decimal";

/** Four places, as a comparison figure: r = k / 10000 for an integer k. */
const SCALE = 10000n;
/** The search stops at a yearly rate of 100 (10000 percent): beyond it the figure is not a comparison. */
const MAX_STEPS = 100n * SCALE;
const MONTHS_PER_YEAR = 12;

function power(base: ExactDecimal, exponent: number): ExactDecimal {
  let result = ExactDecimal.ONE;
  let square = base;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) result = result.mul(square);
    square = square.mul(square);
    remaining = (remaining - (remaining % 2)) / 2;
  }
  return result;
}

/**
 * The yearly rate `r` with `(1 + r)^(months / 12) = cash / face`, to 4 places as
 * a decimal string (`"0.0440"`), or null when none exists (a non-positive cash or
 * face, or a rate beyond 10000 percent). Exact: `(1 + r)^months = (cash / face)^12`
 * is compared as rationals while an integer count of 1/10000 steps is bisected,
 * and the answer is the nearest step (a root exactly halfway rounds up). No
 * floating point anywhere (INV-BOND-003).
 */
export function annualizedReturn(
  cash: ExactDecimal,
  face: ExactDecimal,
  months: number,
): string | null {
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`annualizedReturn: invalid months: ${months}`);
  }
  if (cash.cmp(ExactDecimal.ZERO) <= 0 || face.cmp(ExactDecimal.ZERO) <= 0) {
    return null;
  }
  const target = power(cash.div(face), MONTHS_PER_YEAR);
  const atMostTarget = (steps: bigint, denominator: bigint): boolean =>
    power(ExactDecimal.of(denominator + steps, denominator), months).cmp(
      target,
    ) <= 0;

  // Invariant: the value at `low` is at most the target, the value at `high` is above it.
  let low = -SCALE;
  let high = MAX_STEPS;
  if (atMostTarget(high, SCALE)) return null;
  while (high - low > 1n) {
    const middle = low + (high - low) / 2n;
    if (atMostTarget(middle, SCALE)) low = middle;
    else high = middle;
  }
  // `low` is the step at or below the root; the root is nearer the next step
  // when it is at or above the midpoint.
  const nearest = atMostTarget(2n * low + 1n, 2n * SCALE) ? low + 1n : low;
  return ExactDecimal.of(nearest, SCALE).toFixed(4);
}
