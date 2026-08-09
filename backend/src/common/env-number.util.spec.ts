import { resolvePositiveInt } from "./env-number.util";
import { resolveDailyWriteLimit } from "./daily-write-limiter";

describe("resolvePositiveInt", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a whitespace-only string", "  \t "],
  ])("treats %s as absent: default, not flagged invalid", (_label, raw) => {
    expect(resolvePositiveInt(raw, 7)).toEqual({ value: 7, invalid: false });
  });

  it.each([
    ["a numeric string", "42", 42],
    ["a number", 42, 42],
    ["a string with surrounding space", " 42 ", 42],
    ["one", "1", 1],
  ])("accepts %s", (_label, raw, expected) => {
    expect(resolvePositiveInt(raw, 7)).toEqual({
      value: expected,
      invalid: false,
    });
  });

  it.each([
    ["zero", "0"],
    ["a negative integer", "-1"],
    ["a fraction", "1.5"],
    ["a non-numeric string", "abc"],
    ["a boolean", true],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["an object", {}],
    ["an array", [1, 2]],
  ])("rejects %s: default, flagged invalid", (_label, raw) => {
    expect(resolvePositiveInt(raw, 7)).toEqual({ value: 7, invalid: true });
  });

  it("distinguishes absent from invalid", () => {
    // The whole point of the return shape: both use the fallback, but only
    // one is a misconfiguration a caller should complain about.
    expect(resolvePositiveInt(undefined, 7).invalid).toBe(false);
    expect(resolvePositiveInt("nope", 7).invalid).toBe(true);
  });
});

describe("resolveDailyWriteLimit", () => {
  // Behaviour must be unchanged by the extraction: same inputs, same numbers.
  it.each([
    [undefined, 50],
    [null, 50],
    ["", 50],
    ["abc", 50],
    ["0", 50],
    ["-3", 50],
    ["2.5", 50],
    ["100", 100],
    [100, 100],
  ])("resolves %p to %p", (raw, expected) => {
    expect(resolveDailyWriteLimit(raw, 50)).toBe(expected);
  });
});
