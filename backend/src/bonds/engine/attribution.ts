import { ExactDecimal } from "../domain/exact-decimal";
import { BondTerms } from "../domain/bond-terms";
import { baseAt, compounds, periodRate } from "./accrual";
import { RateScheduleEntry } from "./bond-engine-types";
import { PeriodRate } from "./rate-resolution";

type Attribution = Pick<
  RateScheduleEntry,
  "interest" | "fixedPart" | "benchmarkPart" | "addendPart" | "announcedPart"
>;

const UNKNOWN: Attribution = {
  interest: null,
  fixedPart: null,
  benchmarkPart: null,
  addendPart: null,
  announcedPart: null,
};

const PLACES = 10;
const text = (value: ExactDecimal) => value.toFixed(PLACES);

/**
 * Period `k`'s interest per bond, split by the components of its rate (spec
 * 13.2), computed exactly from the base of the period (`baseAt`, so the terms'
 * base rounding applies) and the rate over one period, r / F. A bond that
 * compounds needs every earlier rate for its base: with one unknown, every
 * figure is null. Nothing is rounded to money here; the parts are for display.
 */
export function attributeInterest(
  terms: BondTerms,
  rates: readonly PeriodRate[],
  k: number,
): Attribution {
  const current = rates[k - 1];
  if (current.rate === null || current.source === null) return UNKNOWN;
  const prior: ExactDecimal[] = [];
  if (compounds(terms)) {
    for (const earlier of rates.slice(0, k - 1)) {
      if (earlier.rate === null) return UNKNOWN;
      prior.push(earlier.rate);
    }
  }
  const base = baseAt(terms, prior);
  const interest = base.mul(periodRate(terms, current.rate));
  const zero = text(ExactDecimal.ZERO);
  const none = {
    fixedPart: zero,
    benchmarkPart: zero,
    addendPart: zero,
    announcedPart: zero,
  };
  const whole = { interest: text(interest), ...none };

  switch (current.source) {
    case "TERMS":
      return { ...whole, fixedPart: text(interest) };
    case "ANNOUNCED":
      return { ...whole, announcedPart: text(interest) };
    case "DERIVED":
    case "PROJECTED": {
      const { benchmark, addend } = current;
      if (benchmark === null || benchmark.flooredValue === null || !addend)
        return { ...whole, fixedPart: text(interest) };
      return {
        ...whole,
        benchmarkPart: text(
          base.mul(
            periodRate(terms, ExactDecimal.parse(benchmark.flooredValue)),
          ),
        ),
        addendPart: text(
          base.mul(periodRate(terms, ExactDecimal.parse(addend))),
        ),
      };
    }
  }
}
