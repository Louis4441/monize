import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/** The file that owns the rule. */
const OWNER = "common/investment-filter.util.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Comments discuss the banned shapes on purpose (this file's own subjects are
 * named in prose in several services), so the scan reads code only.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/--[^\n']*$/gm, "");
}

interface Occurrence {
  file: string;
  line: number;
  text: string;
}

function scan(files: string[], pattern: RegExp): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    const lines = code.split("\n");
    for (const [index, line] of lines.entries()) {
      const match = line.match(pattern);
      if (match) {
        found.push({
          file: relative(SRC_ROOT, file),
          line: index + 1,
          text: match[0].trim(),
        });
      }
    }
  }
  return found;
}

/**
 * A report's account scope is investment LINKAGE, never account type
 * (INV-REPORT-001).
 *
 * An INVESTMENT account in Monize is a pair -- an `INVESTMENT_CASH` sleeve
 * holding real money and an `INVESTMENT_BROKERAGE` sleeve holding securities --
 * so `account_type != 'INVESTMENT'` removed an entire real ledger from fifteen
 * report queries, and the cash legs it was meant to exclude were never
 * described by it in the first place (issue #1257). The mistake is mechanical
 * and was made independently in eight files, so it gets a scanning test:
 * the predicate lives in `common/investment-filter.util.ts` and nowhere else.
 */
describe("investment scope is decided in one place", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("nothing excludes rows by account type", () => {
    const hits = scan(
      files,
      /account_?[Tt]ype\s*(?:!=|<>)\s*['"]INVESTMENT['"]/,
    );

    expect(hits).toEqual([]);
  });

  it("the brokerage-sleeve exclusion is spelled only in the util", () => {
    const hits = scan(files, /(?:!=|<>)\s*['"]INVESTMENT_BROKERAGE['"]/).filter(
      (hit) => hit.file !== OWNER,
    );

    expect(hits).toEqual([]);
  });

  it("the investment-linkage exclusion is spelled only in the util", () => {
    const hits = scan(
      files,
      /NOT EXISTS\s*\(\s*SELECT 1 FROM investment_transactions/,
    ).filter((hit) => hit.file !== OWNER);

    expect(hits).toEqual([]);
  });
});

/**
 * The other half of the rule: every report query that reads the transaction
 * ledger has to apply the exclusion. A query restricted to `is_transfer = true`
 * is exempt by construction -- an investment cash leg is never a transfer -- and
 * that exemption is derived from the query itself rather than kept as a list of
 * file names a new query could quietly join.
 */
describe("every built-in report query applies the investment exclusion", () => {
  const reportServices = readdirSync(join(SRC_ROOT, "built-in-reports"))
    .filter((f) => f.endsWith(".service.ts"))
    .map((f) => join(SRC_ROOT, "built-in-reports", f));

  it("finds the report services", () => {
    expect(reportServices.length).toBeGreaterThan(5);
  });

  it("applies it to every ledger query that is not transfer-only", () => {
    const missing: string[] = [];

    for (const file of reportServices) {
      const source = readFileSync(file, "utf8");
      const segments = source.split("FROM transactions");
      for (const segment of segments.slice(1)) {
        // The query's own template literal ends at the next backtick.
        const query = segment.split("`")[0];
        if (/is_transfer\s*=\s*true/.test(query)) continue;
        if (query.includes("INVESTMENT_EXCLUSION")) continue;
        missing.push(
          `${relative(SRC_ROOT, file)}: ${query.trim().split("\n")[0]}`,
        );
      }
    }

    expect(missing).toEqual([]);
  });
});
