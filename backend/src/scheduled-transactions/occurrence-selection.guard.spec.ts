import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findRepoRoot,
  gitListFiles,
  requireRepoRoot,
} from "../common/repo-tree.util";

/**
 * Occurrence selection is one decision, made in one place (issue #1247,
 * INV-OCCURRENCE-003).
 *
 * The first pass at #1247 centralized the *arithmetic* -- what a schedule costs
 * at today's rate -- and left every consumer to work out which occurrence was
 * due and which override governed it. They did not agree: the budget alert path
 * keyed the override lookup on `overrideDate` when the identity is
 * `originalDate` (so a moved occurrence silently read the template), the
 * Upcoming Bills report applied one schedule-level amount to every projected
 * occurrence, and AI/MCP reported the base for an occurrence the user had
 * re-priced. An import-presence scan cannot see any of that, which is why this
 * guard is about the *shapes* those mistakes take.
 *
 * Each allowlist entry below is a reviewed decision with a reason. Adding a file
 * to one is a deliberate act; the default is to go through
 * `ScheduledOccurrenceService`.
 */

const SRC_PREFIX = "backend/src/";

interface SourceFile {
  path: string;
  lines: string[];
}

function sourceFiles(): SourceFile[] {
  const root = requireRepoRoot(findRepoRoot(__dirname));
  // `--others --exclude-standard` as well as `--cached`: a guard that lists only
  // tracked files is blind to a brand-new one until it is staged, which is how a
  // scan goes green locally and red in CI on the same content.
  return gitListFiles(root, "--cached --others --exclude-standard")
    .filter(
      (f) =>
        f.startsWith(SRC_PREFIX) &&
        f.endsWith(".ts") &&
        !f.endsWith(".spec.ts"),
    )
    .map((f) => ({
      path: f.slice(SRC_PREFIX.length),
      lines: readFileSync(join(root, f), "utf8").split("\n"),
    }));
}

/** Comment-only lines, so the prose describing a rule cannot trip it. */
function isComment(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("*/")
  );
}

/** Whether a loop opens within `window` lines above `index`. */
function insideLoop(lines: string[], index: number, window = 12): boolean {
  for (let i = Math.max(0, index - window); i < index; i += 1) {
    if (/\b(while|for)\s*\(/.test(lines[i])) return true;
  }
  return false;
}

describe("occurrence selection stays in one place", () => {
  const files = sourceFiles();

  it("finds the sources it is meant to scan", () => {
    // A guard that walks the tree with `git ls-files` cannot see an untracked
    // file, and an empty match set is indistinguishable from a clean one.
    expect(files.length).toBeGreaterThan(400);
    expect(files.map((f) => f.path)).toContain(
      "common/scheduled-occurrences.ts",
    );
    expect(files.map((f) => f.path)).toContain(
      "scheduled-transactions/scheduled-occurrence.service.ts",
    );
  });

  /**
   * A recurrence walked in a loop is an occurrence expansion, and there is one.
   * The two allowed sites do different jobs, and only the first one looks at
   * overrides or a window.
   */
  it("expands a recurrence in exactly one place", () => {
    const EXPANDERS = [
      // The one occurrence expander.
      "common/scheduled-occurrences.ts",
      // Rolls a single stale due date forward to the present during a Money
      // import. No window and no overrides: it answers "when is this bill next
      // due" for a row being created, not "which occurrences fall in a range".
      "import/mny/map/map-bills.ts",
    ];

    const offenders: string[] = [];
    for (const file of files) {
      if (EXPANDERS.includes(file.path)) continue;
      file.lines.forEach((line, i) => {
        if (isComment(line)) return;
        if (!/calculateNextDueDate\s*\(|advanceByFrequency\s*\(/.test(line)) {
          return;
        }
        if (insideLoop(file.lines, i)) {
          offenders.push(`${file.path}:${i + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  /**
   * Choosing which override governs an occurrence -- and therefore whether the
   * base amount applies -- happens in the occurrence service. `??` collapsing
   * "no override" with "override priced as unknown" is the specific mistake this
   * keeps out of new code.
   */
  it("selects an override in exactly one place", () => {
    const SELECTORS = [
      // Defines the key and files each override's answer under it.
      "scheduled-transactions/scheduled-effective-amount.service.ts",
      // The one selector: matches the occurrence's slot to its override.
      "scheduled-transactions/scheduled-occurrence.service.ts",
      // Decorates EVERY override in the list read model with its own effective
      // amount. It selects no occurrence -- the client's occurrence-level answer
      // comes from the occurrences endpoint.
      "scheduled-transactions/scheduled-transactions.service.ts",
    ];

    const offenders: string[] = [];
    for (const file of files) {
      if (SELECTORS.includes(file.path)) continue;
      file.lines.forEach((line, i) => {
        if (isComment(line)) return;
        if (/overrideEffectiveKey\s*\(/.test(line)) {
          offenders.push(`${file.path}:${i + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  /**
   * `base` is the answer for "every occurrence with no override". A surface that
   * reports ONE occurrence must not read it: that is how AI/MCP, the budget and
   * the report each ended up quoting the template for an occurrence the user had
   * changed.
   */
  it("reads the resolver's base amount only where the base is the question", () => {
    // Counts, not a blanket exemption: `scheduled-transactions.service.ts` is
    // 4000 lines, and a file-level allowance would let a NEW occurrence-aware
    // method in it read the base freely. Shrink-only -- a lower number is a
    // migration, a higher one needs its own argument here.
    const ALLOWED_BASE_READS = new Map([
      ["scheduled-transactions/scheduled-effective-amount.service.ts", 8],
      ["scheduled-transactions/scheduled-occurrence.service.ts", 1],
      // findAll's schedule-level read model: `effectiveAmount` on a schedule row
      // is by definition the base, and the row carries its overrides beside it.
      ["scheduled-transactions/scheduled-transactions.service.ts", 3],
    ]);

    const counts = new Map<string, number>();
    for (const file of files) {
      file.lines.forEach((line) => {
        if (isComment(line)) return;
        if (/\.base\.(amount|complete|currencyCode)\b/.test(line)) {
          counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
        }
      });
    }

    const offenders = [...counts.entries()]
      .filter(([path, count]) => count > (ALLOWED_BASE_READS.get(path) ?? 0))
      .map(([path, count]) => `${path}: ${count} base reads`);

    expect(offenders).toEqual([]);
  });

  /**
   * The resolver is the arithmetic layer. A consumer holding schedule rows asks
   * the occurrence service, which asks the resolver once -- so a new
   * `resolveMany` call site is a new occurrence-selection decision and has to be
   * argued for here.
   */
  it("calls the effective-amount resolver only from declared places", () => {
    // Also counted, for the same reason as the base reads above.
    const ALLOWED_RESOLVER_CALLS = new Map([
      // `resolveOne` delegates to `resolveMany`.
      ["scheduled-transactions/scheduled-effective-amount.service.ts", 1],
      // The one consumer: prices the occurrences it has expanded.
      ["scheduled-transactions/scheduled-occurrence.service.ts", 1],
      // The schedule-level list read model (see above).
      ["scheduled-transactions/scheduled-transactions.service.ts", 1],
    ]);

    const counts = new Map<string, number>();
    for (const file of files) {
      file.lines.forEach((line) => {
        if (isComment(line)) return;
        if (/\.(resolveMany|resolveOne)\s*\(/.test(line)) {
          counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
        }
      });
    }

    const offenders = [...counts.entries()]
      .filter(
        ([path, count]) => count > (ALLOWED_RESOLVER_CALLS.get(path) ?? 0),
      )
      .map(([path, count]) => `${path}: ${count} resolver calls`);

    expect(offenders).toEqual([]);
  });

  // The predicates themselves, pinned: a guard whose matcher quietly stopped
  // matching would report a clean tree for ever.
  describe("its own matchers", () => {
    it("recognises the shapes it bans", () => {
      const lines = [
        "    while (d <= horizon) {",
        "      const next = calculateNextDueDate(d, s.frequency);",
      ];
      expect(insideLoop(lines, 1)).toBe(true);
      expect(
        /overrideEffectiveKey\s*\(/.test(
          "resolved.overrides.get(overrideEffectiveKey(o))",
        ),
      ).toBe(true);
      expect(
        /\.base\.(amount|complete|currencyCode)\b/.test(
          "effective.get(r.id)!.base.amount",
        ),
      ).toBe(true);
      expect(
        /\.(resolveMany|resolveOne)\s*\(/.test(
          "await this.effectiveAmounts.resolveMany(userId, rows)",
        ),
      ).toBe(true);
    });

    it("does not fire on the prose that describes them", () => {
      expect(isComment("   * `resolved.base` is the wrong member here")).toBe(
        true,
      );
      expect(isComment("// calculateNextDueDate in a while loop")).toBe(true);
      expect(isComment("const own = resolved.overrides.get(key);")).toBe(false);
    });

    it("does not fire on a single advance outside a loop", () => {
      const lines = [
        "  private advance(row: ScheduledTransaction): string {",
        "    return calculateNextDueDate(row.nextDueDate, row.frequency);",
      ];
      expect(insideLoop(lines, 1)).toBe(false);
    });
  });
});
