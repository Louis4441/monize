/**
 * Payment frequencies, and the one place each is turned into something else.
 *
 * There are two frequency domains -- loan (`PaymentFrequency`, the recurrence
 * spellings the setup DTO validates) and mortgage (`MortgagePaymentFrequency`,
 * which adds `SEMI_MONTHLY` and the accelerated cadences) -- and three
 * conversions between them and the scheduler. Every one of them used to be a
 * hand-rolled object or `switch` in whichever file needed it, and the copies
 * disagreed: one mapped `SEMI_MONTHLY` to itself (a value the recurrence engine
 * does not recognize, so the occurrence was due forever), another had no
 * `SEMIMONTHLY` case at all and fell through to monthly.
 *
 * This module exists so the two amortization utils can share them without
 * importing each other. They did, briefly, and the cycle was worse than the
 * duplication it removed: under a mortgage-first load order the merged table
 * initialised without any mortgage key, so an accelerated-biweekly mortgage's
 * scheduled transaction was created MONTHLY -- silently, and only in some import
 * orders.
 */

import { FrequencyType, calculateNextDueDate } from "../common/recurrence";

/**
 * Payment frequencies a loan account can carry.
 *
 * These are the *scheduled transaction* recurrence spellings, because that is
 * what reaches the helpers: `SetupLoanPaymentsDto.paymentFrequency` is validated
 * as one of these and passed straight through. Note `SEMIMONTHLY` has no
 * underscore here and `SEMI_MONTHLY` does in `MortgagePaymentFrequency` -- two
 * enums, two spellings, and the mismatch is why this one was once missing: the
 * DTO accepted `SEMIMONTHLY`, `getPeriodsPerYear` fell through to its
 * `default: 12`, and a semi-monthly loan's interest split was computed at twice
 * the correct rate. `loan-payment-frequency.guard.spec.ts` reads the DTO's
 * `@IsIn` list and fails on any accepted value this module cannot handle.
 */
export type PaymentFrequency =
  | "WEEKLY"
  | "BIWEEKLY"
  | "SEMIMONTHLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY";

export type MortgagePaymentFrequency =
  | "MONTHLY"
  | "SEMI_MONTHLY" // 24 payments/year (1st and 15th)
  | "BIWEEKLY" // 26 payments/year
  | "ACCELERATED_BIWEEKLY" // 26 payments/year, but each = monthly/2
  | "WEEKLY" // 52 payments/year
  | "ACCELERATED_WEEKLY"; // 52 payments/year, but each = monthly/4

/**
 * The recurrence frequency each loan payment frequency schedules at.
 *
 * A `Record` rather than a `switch`, so adding a member to `PaymentFrequency`
 * without deciding how it recurs is a compile error.
 */
export const LOAN_FREQUENCY_TO_RECURRENCE: Record<
  PaymentFrequency,
  FrequencyType
> = {
  WEEKLY: "WEEKLY",
  BIWEEKLY: "BIWEEKLY",
  SEMIMONTHLY: "SEMIMONTHLY",
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
  YEARLY: "YEARLY",
};

/**
 * The recurrence frequency each mortgage payment frequency schedules at.
 *
 * The accelerated frequencies pay a fraction of the monthly installment on the
 * base cadence, so they schedule as that base cadence.
 */
export const MORTGAGE_FREQUENCY_TO_RECURRENCE: Record<
  MortgagePaymentFrequency,
  FrequencyType
> = {
  MONTHLY: "MONTHLY",
  SEMI_MONTHLY: "SEMIMONTHLY",
  BIWEEKLY: "BIWEEKLY",
  ACCELERATED_BIWEEKLY: "BIWEEKLY",
  WEEKLY: "WEEKLY",
  ACCELERATED_WEEKLY: "WEEKLY",
};

/**
 * The recurrence frequency to schedule at, for any payment-frequency spelling
 * either domain uses.
 *
 * Merged from the two tables rather than written a third time:
 * `SetupLoanPaymentsDto` accepts loan spellings, but mortgage callers reach the
 * same service carrying mortgage ones. The shared keys map identically in both,
 * so the merge order does not matter.
 */
export const SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY: Record<
  string,
  FrequencyType
> = {
  ...LOAN_FREQUENCY_TO_RECURRENCE,
  ...MORTGAGE_FREQUENCY_TO_RECURRENCE,
};

/**
 * The mortgage-domain spelling of a payment frequency, or `null` when the
 * mortgage helpers cannot express it.
 *
 * `SetupLoanPaymentsDto` validates *recurrence* spellings, so its value reaches
 * the mortgage helpers through a conversion. Casting instead handed
 * `getMortgagePeriodsPerYear` values it has no case for -- `SEMIMONTHLY` (the
 * only semi-monthly spelling the DTO accepts), `QUARTERLY` and `YEARLY` -- and
 * its `default: 12` turned each into a monthly rate: twice the interest per
 * period for semi-monthly, three times for quarterly.
 *
 * Quarterly and yearly return `null` rather than a nearest match: a mortgage in
 * this model has no such cadence, and a caller must refuse rather than compute a
 * confident wrong split. Accelerated frequencies are already mortgage-domain
 * names and pass through.
 */
export function toMortgagePaymentFrequency(
  frequency: string,
): MortgagePaymentFrequency | null {
  switch (frequency) {
    case "MONTHLY":
    case "SEMI_MONTHLY":
    case "BIWEEKLY":
    case "WEEKLY":
    case "ACCELERATED_BIWEEKLY":
    case "ACCELERATED_WEEKLY":
      return frequency;
    case "SEMIMONTHLY":
      return "SEMI_MONTHLY";
    default:
      return null;
  }
}

/**
 * Highest payment count the end-date helpers will date. Above it the loan is
 * treated as never paying off.
 *
 * Exported because `createLoanAccount` and `createMortgageAccount` gate on the
 * same ceiling -- they only write an `endDate` when the count is at or below it
 * -- and two literals disagreed at the boundary (the util dated exactly 10000
 * while the service refused it).
 */
export const MAX_DATEABLE_PAYMENTS = 10000;

/**
 * `date` advanced `steps` occurrences of `frequency`, through the recurrence
 * engine that will actually post those payments.
 *
 * The engine rather than a second calendar, because a payoff date's whole job is
 * to bound the linked scheduled transaction: it has to be a date the scheduler
 * reaches. A hand-rolled semi-monthly step (the 1st and the 15th) against the
 * engine's own (the 15th and the last day of the month) dated payment 24 of a
 * 24-payment schedule *before* the final installment, so the schedule it bounded
 * posted 23 of them. It follows that month-end drift here is whatever the
 * scheduler's drift is, by construction.
 *
 * The conversion is local-time in both directions, so a `Date` built as
 * `new Date(2026, 0, 1)` round-trips to the same wall-clock day whatever the
 * container's offset -- `ensureYMD` reads UTC and would shift the day west of
 * Greenwich.
 */
export function advancePaymentDates(
  date: Date,
  frequency: FrequencyType,
  steps: number,
): Date {
  let ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
  for (let i = 0; i < steps; i++) {
    ymd = calculateNextDueDate(ymd, frequency);
  }
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(year, month - 1, day);
}
