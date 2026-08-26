import { readFileSync } from "fs";
import { join } from "path";
import { PaymentFrequency, getPeriodsPerYear } from "./loan-amortization.util";
import { paymentsToClear } from "./amortization-count.util";

/**
 * `SetupLoanPaymentsDto.paymentFrequency` is a validated string that
 * `LoanPaymentSetupService` casts straight into `calculatePaymentSplit`, so the
 * DTO's accepted set and `getPeriodsPerYear`'s cases are one contract with a
 * cast in the middle. When they drifted, `getPeriodsPerYear` fell through to its
 * `default: 12` and a `SEMIMONTHLY` loan's interest split came out at twice the
 * correct rate -- silently, because a default is not an error.
 *
 * A cast cannot be type-checked, so this is the scan that checks it. It reads
 * the `@IsIn` list out of the DTO source rather than trusting a copy here.
 */
function acceptedFrequencies(): string[] {
  const source = readFileSync(
    join(__dirname, "dto", "setup-loan-payments.dto.ts"),
    "utf8",
  );
  const match = source.match(/@IsIn\(\[([^\]]*)\]\)\s*\n\s*paymentFrequency:/);
  if (!match) {
    throw new Error(
      "setup-loan-payments.dto.ts no longer declares paymentFrequency with an @IsIn list; " +
        "update this guard to read whatever validates it now",
    );
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("loan payment frequency contract", () => {
  it("reads a non-empty accepted set out of the DTO", () => {
    const accepted = acceptedFrequencies();
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted).toContain("MONTHLY");
  });

  it("gives every DTO-accepted frequency its own period count", () => {
    // A frequency that misses every case silently becomes monthly. Each one is
    // asserted against its own expected count rather than merely "not 12", so a
    // wrong case is caught as well as a missing one.
    const expected: Record<string, number> = {
      WEEKLY: 52,
      BIWEEKLY: 26,
      SEMIMONTHLY: 24,
      MONTHLY: 12,
      QUARTERLY: 4,
      YEARLY: 1,
    };
    for (const frequency of acceptedFrequencies()) {
      expect(expected[frequency]).toBeDefined();
      expect(getPeriodsPerYear(frequency as PaymentFrequency)).toBe(
        expected[frequency],
      );
    }
  });

  it("splits a semi-monthly payment at half a month's interest, not a month's", () => {
    // The defect, stated as money: 100k at 6% semi-monthly accrues 250 per
    // period (6% / 24), not the 500 the monthly fall-through charged.
    const periodsPerYear = getPeriodsPerYear("SEMIMONTHLY");
    expect((100000 * 6) / 100 / periodsPerYear).toBeCloseTo(250, 6);
  });
});

describe("paymentsToClear", () => {
  it("solves the annuity count", () => {
    // 100k at 6% nominal monthly paying 1000: independently
    // n = -ln(1 - 100000*0.005/1000) / ln(1.005) = 138.98 -> 139
    expect(paymentsToClear(100000, 0.005, 1000)).toBe(139);
  });

  it("divides evenly at a 0% rate", () => {
    expect(paymentsToClear(10000, 0, 5000)).toBe(2);
    // A remainder still needs its own period.
    expect(paymentsToClear(10001, 0, 5000)).toBe(3);
  });

  it("is Infinity when the payment never covers the interest", () => {
    // Exactly the interest is not enough either: the balance never falls.
    expect(paymentsToClear(100000, 0.005, 500)).toBe(Infinity);
    expect(paymentsToClear(100000, 0.005, 499)).toBe(Infinity);
    expect(paymentsToClear(100000, 0.005, 0)).toBe(Infinity);
    expect(paymentsToClear(100000, 0.005, -50)).toBe(Infinity);
  });

  it("needs no payments for nothing owed", () => {
    expect(paymentsToClear(0, 0.005, 1000)).toBe(0);
  });
});
