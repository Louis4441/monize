import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * A silent currency-conversion fallback is a one-token mistake, so it gets a
 * scan rather than a paragraph.
 *
 * Audit finding P5-009: two conversion paths turned "no rate available" into
 * "rate 1.0" -- `return result ?? amount` and
 * `rate = reverseRate !== null ? 1 / reverseRate : 1`. 1,000 USD reported into
 * a EUR total came out as 1,000 EUR, an 11% overstatement that is numerically
 * plausible, and nothing in the response distinguished it from a genuine 1:1.
 *
 * The rule: a conversion returns `null` when it has no rate, and callers
 * accumulate through `FxAggregate`. Rate 1 is reachable only when the source
 * and destination currency codes are equal. See
 * `docs/specs/fx-conversion-completeness.md`.
 */
describe("currency conversion has no silent identity fallback", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never falls back from a failed conversion to the input amount", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `?? amount`, `|| amount`, `?? value` right where a conversion result
        // is consumed -- the exact shape of the removed defect.
        if (/(\?\?|\|\|)\s*(amount|rawValue|value)\s*;?\s*$/.test(line)) {
          const context = lines
            .slice(Math.max(0, index - 6), index + 1)
            .join("\n");
          if (/convert|Convert|rate|Rate/.test(context)) {
            offenders.push(`${rel}:${index + 1}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The rule is "a conversion with no rate returns null", and `?? amount` is
   * only one way to break it. The scan above was written from the shape of the
   * two fixed defects, so it matches a fallback that ends a line -- and an
   * `if (result == null) { log(); return amount; }` block, which returns the
   * unconverted amount just as surely, passed straight through it.
   *
   * So this scan is written from the rule instead: a statement handing back the
   * function's own input, inside a null-check of a conversion result, is the
   * violation whatever punctuation it wears.
   *
   * Each entry names a call site that DOES this today, with the reason it is
   * still here. An allowlist is a worse mechanism than no violations, and it is
   * a much better one than a scan that cannot see them: the entry is what makes
   * the gap reviewable, and INV-FX-001 in `docs/system-invariants.md` is
   * `partial` rather than `enforced` for exactly as long as this list is not
   * empty.
   */
  const RETURNS_ITS_INPUT_UNCONVERTED: ReadonlyArray<{
    file: string;
    reason: string;
  }> = [
    {
      file: "built-in-reports/report-currency.service.ts",
      reason:
        "convertAmount() logs a warning and returns the unconverted amount " +
        "when no rate exists, and data-quality-reports.service.ts then labels " +
        "that figure `currencyCode: defaultCurrency` -- an unconverted amount " +
        "under the target currency's name, which is the second half of " +
        "INV-FX-001. It is not fixed here because the signature is `number`, " +
        "shared by ten report services: closing it means each of them " +
        "deciding its own missing-data policy and carrying a completeness " +
        "field on its DTO, which is a specified change of its own rather than " +
        "a guard's business. Removing this entry is what closes INV-FX-001.",
    },
  ];

  it("never returns its own input from a conversion's null branch", () => {
    // A bare `return amount;` / `return value;` -- no `??`, no `||`, so the
    // scan above cannot see it.
    const RETURNS_INPUT =
      /^\s*return\s+(?:amount|rawValue|value|input)\s*;\s*$/;
    // The branch it sits in has to be about a conversion that came back empty.
    const CONVERSION = /convert|Convert|\brate\b|Rate/;
    const ABSENT_RESULT =
      /(?:==|===)\s*null|(?:==|===)\s*undefined|!\s*(?:result|converted|convertedAmount)\b/;

    const allowed = new Set(RETURNS_ITS_INPUT_UNCONVERTED.map((e) => e.file));
    const offenders: string[] = [];
    const allowedHits: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!RETURNS_INPUT.test(line)) continue;
        const context = lines
          .slice(Math.max(0, index - 8), index + 1)
          .join("\n");
        if (!CONVERSION.test(context) || !ABSENT_RESULT.test(context)) continue;
        (allowed.has(rel) ? allowedHits : offenders).push(
          `${rel}:${index + 1}`,
        );
      }
    }

    expect(offenders).toEqual([]);
    // The allowlist is shrink-only: an entry whose call site has been fixed (or
    // moved) has to go, or the next one hides behind it.
    expect(allowedHits.map((hit) => hit.split(":")[0])).toEqual(
      RETURNS_ITS_INPUT_UNCONVERTED.map((entry) => entry.file),
    );
  });

  it("recognises the returned-input shape it bans", () => {
    // Both directions, so neither half can quietly stop working: the block the
    // scan exists for is caught, and a conversion that correctly returns null
    // is not.
    const RETURNS_INPUT =
      /^\s*return\s+(?:amount|rawValue|value|input)\s*;\s*$/;
    const caught = [
      "    const result = convertWithRateLookup(amount, from, to, getRate);",
      "    if (result == null) {",
      "      this.logger.warn(`no rate for ${from} -> ${to}`);",
      "      return amount;",
    ];
    const clean = [
      "    const result = convertWithRateLookup(amount, from, to, getRate);",
      "    if (result == null) return null;",
      "    return result;",
    ];

    expect(caught.some((line) => RETURNS_INPUT.test(line))).toBe(true);
    expect(clean.some((line) => RETURNS_INPUT.test(line))).toBe(false);
  });

  it("never defaults a missing exchange rate to 1", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `rate = ... : 1`, `rate ?? 1`, `rate || 1` -- assigning 1 as the
        // answer for a pair whose rate could not be found. A literal 1 for the
        // same-currency case is fine and does not match: it is not assigned to
        // a variable named for a rate out of a failed lookup.
        const assignsOneToRate =
          /\brate\w*\s*=\s*[^;]*[?:]\s*1\s*;/i.test(line) ||
          /\brate\w*\s*(\?\?|\|\|)\s*1\b/i.test(line);
        if (assignsOneToRate) offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("reciprocates a reverse rate only in reviewed places", () => {
    // "Try direct, then try the reverse and reciprocate" is the shape that has
    // to end in `null` when neither exists -- three copies of it ended in `1`
    // instead. Reciprocating is legitimate; doing it in a new place without
    // deciding what happens when there is no rate is not.
    //
    // Adding a file here is a reviewed decision: confirm the branch returns
    // null (or a typed unknown) rather than 1 before doing it.
    const allowed = new Set([
      // The shared date-aware helper -- the single direct/inverse decision.
      "common/currency-conversion.util.ts",
      // Persists the inverse pair alongside the direct one, at rate precision.
      "currencies/exchange-rate.service.ts",
      // Latest-rate resolvers, each returning null when the pair is unknown.
      "securities/portfolio-calculation.service.ts",
      "investment-reports/investment-report-data.service.ts",
      "strategies/gem-position.service.ts",
    ]);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (allowed.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (/1\s*\/\s*(reverse|inverse)\w*/i.test(source)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("every reviewed reciprocal returns null when neither direction exists", () => {
    // The allowlist above is only meaningful if the files on it actually
    // handle the absent case. Each must mention returning null near its
    // reciprocal rather than falling through to a number.
    const resolvers = [
      "securities/portfolio-calculation.service.ts",
      "investment-reports/investment-report-data.service.ts",
      "strategies/gem-position.service.ts",
    ];

    for (const rel of resolvers) {
      const source = readFileSync(join(SRC_ROOT, rel), "utf8");
      const idx = source.search(/1\s*\/\s*(reverse|inverse)\w*/i);
      expect(idx).toBeGreaterThan(-1);
      // Look at the surrounding block for the null-return decision.
      const around = source.slice(Math.max(0, idx - 400), idx + 200);
      expect(around).toMatch(/null/);
    }
  });
});
