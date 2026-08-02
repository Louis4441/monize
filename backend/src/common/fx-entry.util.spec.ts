import { BadRequestException } from "@nestjs/common";
import {
  applyFxConversion,
  normalizeFxEntry,
  roundFxRate,
  FX_RATE_DECIMALS,
} from "./fx-entry.util";

describe("fx-entry.util", () => {
  describe("normalizeFxEntry", () => {
    it("returns nulls when neither field is present", () => {
      expect(normalizeFxEntry({ amount: -50 }, "CAD")).toEqual({
        originalAmount: null,
        originalCurrencyCode: null,
      });
    });

    it("rejects a half-supplied pair", () => {
      expect(() =>
        normalizeFxEntry({ amount: -50, originalAmount: -40 }, "CAD"),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizeFxEntry({ amount: -50, originalCurrencyCode: "USD" }, "CAD"),
      ).toThrow(BadRequestException);
    });

    it("strips the pair when the entry currency is the account currency", () => {
      expect(
        normalizeFxEntry(
          {
            amount: -50,
            originalAmount: -50,
            originalCurrencyCode: "cad",
            exchangeRate: 1,
          },
          "CAD",
        ),
      ).toEqual({ originalAmount: null, originalCurrencyCode: null });
    });

    it("requires a positive rate", () => {
      expect(() =>
        normalizeFxEntry(
          { amount: -50, originalAmount: -40, originalCurrencyCode: "USD" },
          "CAD",
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizeFxEntry(
          {
            amount: -50,
            originalAmount: -40,
            originalCurrencyCode: "USD",
            exchangeRate: 0,
          },
          "CAD",
        ),
      ).toThrow(BadRequestException);
    });

    it("rejects a sign mismatch between the two amounts", () => {
      expect(() =>
        normalizeFxEntry(
          {
            amount: -50,
            originalAmount: 40,
            originalCurrencyCode: "USD",
            exchangeRate: 1.37,
          },
          "CAD",
        ),
      ).toThrow(BadRequestException);
    });

    it("uppercases and keeps a valid pair", () => {
      expect(
        normalizeFxEntry(
          {
            amount: -54.8,
            originalAmount: -40,
            originalCurrencyCode: "usd",
            exchangeRate: 1.37,
          },
          "CAD",
        ),
      ).toEqual({ originalAmount: -40, originalCurrencyCode: "USD" });
    });
  });

  describe("roundFxRate", () => {
    it("keeps a rate at the column's ten decimal places", () => {
      expect(FX_RATE_DECIMALS).toBe(10);
      expect(roundFxRate(1 / 1.3652)).toBeCloseTo(0.7324934076, 10);
    });

    it("does not collapse a six-decimal rate to four", () => {
      // The regression this replaced: roundMoney(1/1.3652) gave 0.7325, which
      // inverts back to 1.36519... -> 1.3661 at four decimals.
      const inverse = roundFxRate(1 / 1.3652);
      expect(inverse).not.toBe(0.7325);
      expect(roundFxRate(1 / inverse)).toBeCloseTo(1.3652, 6);
    });
  });

  describe("applyFxConversion", () => {
    it("converts without a fee", () => {
      expect(applyFxConversion(-40, 1.3652, null)).toEqual({
        base: -54.608,
        fee: 0,
        amount: -54.608,
      });
    });

    it("folds a foreign transaction fee into the amount", () => {
      const { base, fee, amount } = applyFxConversion(-40, 1.3652, 2.5);
      expect(base).toBe(-54.608);
      expect(fee).toBe(-1.3652);
      expect(amount).toBe(-55.9732);
    });

    it("charges the fee as a cost on an inbound amount too", () => {
      const { fee, amount } = applyFxConversion(40, 1.3652, 2.5);
      expect(fee).toBe(-1.3652);
      expect(amount).toBe(53.2428);
    });

    it("uses the full rate precision rather than a rounded one", () => {
      // A six-decimal rate on a four-figure amount: rounding the rate to four
      // decimals first would lose cents.
      const precise = applyFxConversion(1000, 1.365234, null).amount;
      const rounded = applyFxConversion(1000, 1.3652, null).amount;
      expect(precise).toBe(1365.234);
      expect(precise).not.toBe(rounded);
    });
  });
});
