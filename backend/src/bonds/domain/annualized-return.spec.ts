import { annualizedReturn } from "./annualized-return";
import { ExactDecimal } from "./exact-decimal";

const d = ExactDecimal.parse;

describe("annualizedReturn", () => {
  it("gives 4.40 percent for 100 compounding at 4.40% for three years", () => {
    // 100 x 1.044^3 = 113.79 after the letter's per-period rounding
    expect(annualizedReturn(d("113.79"), d("100"), 36)).toBe("0.0440");
  });

  it("is 0.0000 when the cash equals the face value", () => {
    expect(annualizedReturn(d("100.00"), d("100"), 36)).toBe("0.0000");
  });

  it("is negative when less than the face comes back", () => {
    expect(annualizedReturn(d("90.00"), d("100"), 12)).toBe("-0.1000");
  });

  it("annualizes a short bond: 3 months at 2% a year paid as one coupon", () => {
    // (100.50 / 100)^4 - 1 = 0.020150... -> 0.0202
    expect(annualizedReturn(d("100.50"), d("100"), 3)).toBe("0.0202");
  });

  it("annualizes ten years of EDO-like compounding", () => {
    // 100 x 1.06^10 = 179.0848 -> 179.08
    expect(annualizedReturn(d("179.08"), d("100"), 120)).toBe("0.0600");
  });

  it("rounds to the nearest step, a root exactly halfway rounding up", () => {
    // (1.00005)^12 months=12 -> r = 0.00005 exactly: halfway between 0.0000 and 0.0001
    expect(annualizedReturn(d("100.005"), d("100"), 12)).toBe("0.0001");
    expect(annualizedReturn(d("100.0049"), d("100"), 12)).toBe("0.0000");
  });

  it("is null for a non-positive cash or face value", () => {
    expect(annualizedReturn(d("0"), d("100"), 12)).toBeNull();
    expect(annualizedReturn(d("-5"), d("100"), 12)).toBeNull();
    expect(annualizedReturn(d("100"), d("0"), 12)).toBeNull();
  });

  it("is null beyond a yearly rate of 100", () => {
    expect(annualizedReturn(d("100000"), d("100"), 3)).toBeNull();
  });

  it("refuses a length that is not a positive whole number of months", () => {
    expect(() => annualizedReturn(d("100"), d("100"), 0)).toThrow(RangeError);
    expect(() => annualizedReturn(d("100"), d("100"), 1.5)).toThrow(RangeError);
  });
});
