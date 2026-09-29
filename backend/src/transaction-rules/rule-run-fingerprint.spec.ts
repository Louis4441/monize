import { RuleTraceChanges } from "./rule-effects";
import { canonicalChanges, planFingerprint } from "./rule-run-fingerprint";

const change = (id: string, changes: RuleTraceChanges) => ({
  transactionId: id,
  changes,
});

describe("planFingerprint", () => {
  const a = change("a", { categoryId: { before: null, after: "c1" } });
  const b = change("b", {
    tagIds: { before: [], after: ["g1", "g2"] },
  });

  it("is a SHA-256 hex digest", () => {
    expect(planFingerprint(1, [a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order the rows were planned in", () => {
    expect(planFingerprint(1, [a, b])).toBe(planFingerprint(1, [b, a]));
  });

  it("does not depend on the order of a tag set", () => {
    const reordered = change("b", {
      tagIds: { before: [], after: ["g2", "g1"] },
    });
    expect(planFingerprint(1, [a, b])).toBe(planFingerprint(1, [a, reordered]));
  });

  it("changes with the rule revision", () => {
    expect(planFingerprint(1, [a, b])).not.toBe(planFingerprint(2, [a, b]));
  });

  it("changes with a row, a change or a missing row", () => {
    const base = planFingerprint(1, [a, b]);
    expect(planFingerprint(1, [a])).not.toBe(base);
    expect(
      planFingerprint(1, [
        change("a", { categoryId: { before: null, after: "c2" } }),
        b,
      ]),
    ).not.toBe(base);
    expect(
      planFingerprint(1, [
        change("a", { categoryId: { before: "c0", after: "c1" } }),
        b,
      ]),
    ).not.toBe(base);
    expect(planFingerprint(1, [change("z", a.changes), b])).not.toBe(base);
  });

  it("an empty plan still has a fingerprint that depends on the revision", () => {
    expect(planFingerprint(1, [])).not.toBe(planFingerprint(2, []));
  });
});

describe("canonicalChanges", () => {
  it("fixes the key order and nulls the absent fields", () => {
    expect(
      JSON.stringify(
        canonicalChanges({
          tagIds: { before: ["b", "a"], after: ["c"] },
        }),
      ),
    ).toBe(
      '{"categoryId":null,"payeeId":null,"tagIds":{"before":["a","b"],"after":["c"]}}',
    );
  });
});
