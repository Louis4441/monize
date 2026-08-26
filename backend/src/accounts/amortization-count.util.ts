/**
 * How many payments an installment needs to clear a balance.
 *
 * One implementation of `n = -ln(1 - P*r / A) / ln(1 + r)`, because it had three:
 * `calculateAcceleratedPayments` and `calculateResidualPayoff` in
 * mortgage-amortization.util.ts, and `calculateTotalPayments` in
 * loan-amortization.util.ts. Three copies of one financial formula is exactly
 * the drift the "written once, in the place that can check it" rule targets --
 * and two of them were being evaluated on the same inputs in a single call.
 */

/**
 * Whole number of payments of `paymentAmount` needed to clear `principal` at
 * `periodicRate` per period.
 *
 * `Infinity` when the loan never amortizes: a non-positive payment, or one that
 * does not exceed the first period's interest. Callers must distinguish that
 * from a number -- reporting a finite total for a schedule that never ends is
 * the "unknown rendered as a measured value" defect in its worst form.
 *
 * @param principal - Balance to clear (positive)
 * @param periodicRate - Interest rate per payment period, as a decimal
 * @param paymentAmount - The regular installment
 * @returns Payments needed, rounded up; `Infinity` when it never amortizes
 */
export function paymentsToClear(
  principal: number,
  periodicRate: number,
  paymentAmount: number,
): number {
  if (paymentAmount <= 0) return Infinity;
  if (principal <= 0) return 0;
  if (periodicRate === 0) {
    return Math.ceil(principal / paymentAmount);
  }
  // The payment must beat the first period's interest, or the balance grows.
  if (paymentAmount <= principal * periodicRate) return Infinity;
  return Math.ceil(
    -Math.log(1 - (principal * periodicRate) / paymentAmount) /
      Math.log(1 + periodicRate),
  );
}
