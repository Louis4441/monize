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
 * The other half of the rule, and the half a substring match cannot carry:
 * every report query that reads the transaction ledger must apply the exclusion
 * in the representation its own shape needs.
 *
 * A query that JOINS `transaction_splits` classifies each line, so the
 * split-aware conjunction is enough. A query that reads only the parent cannot:
 * `t.amount` on a split parent is the sum of ALL its children, and an embedded
 * investment line's `transaction_id` is null, so the transaction-level linkage
 * cannot see it -- that query has to derive its amount through
 * `reportableTransactionAmountSql` (branch audit F-RPT-001). Accepting the
 * substring `INVESTMENT_EXCLUSION` would pass a parent-only query that chose the
 * `_NO_SPLITS` variant, which is exactly the defect.
 *
 * Two exemptions, both derived from the query rather than kept as a list of file
 * names a new query could quietly join: one restricted to transfers (an
 * investment cash leg is never a transfer), and one that declares itself a
 * PARENT-IDENTITY REPORT, whose subject is the stored row rather than its cash
 * meaning.
 *
 * "Restricted to transfers" is positive proof, not the presence of the token:
 * the monthly category breakdown admits `is_transfer = false` rows AND, in an OR
 * branch, categorized transfer outflows, so matching `is_transfer = true`
 * anywhere exempted a split-joining ledger query from the whole scan -- deleting
 * its exclusion would have left the guard green (re-audit F-GUARD-001). A query
 * that mentions both forms is not restricted to either.
 */
type QueryShape =
  | "transfer-only"
  | "parent-identity"
  | "split-aware"
  | "parent-only";

export function classifyLedgerQuery(query: string): {
  shape: QueryShape;
  missing: string[];
} {
  const readsTransfers = /is_transfer\s*=\s*true/.test(query);
  const readsNonTransfers = /is_transfer\s*=\s*false/.test(query);
  if (readsTransfers && !readsNonTransfers) {
    return { shape: "transfer-only", missing: [] };
  }

  const missing: string[] = [];
  if (/PARENT-IDENTITY REPORT/.test(query)) {
    if (!query.includes("INVESTMENT_EXCLUSION")) {
      missing.push("an investment exclusion");
    }
    return { shape: "parent-identity", missing };
  }

  if (/JOIN transaction_splits/.test(query)) {
    // The split-aware constant, not the _NO_SPLITS one: `${INVESTMENT_EXCLUSION}`
    // ends at the closing brace.
    if (!/\$\{INVESTMENT_EXCLUSION\}/.test(query)) {
      missing.push("the split-aware INVESTMENT_EXCLUSION");
    }
    return { shape: "split-aware", missing };
  }

  if (!query.includes("INVESTMENT_EXCLUSION")) {
    missing.push("an investment exclusion");
  }
  if (!query.includes("REPORTABLE_TX_AMOUNT")) {
    missing.push("a reportable-amount derivation (reads t.amount on a parent)");
  }
  return { shape: "parent-only", missing };
}

/** Every `FROM transactions` query in a file, cut at its template literal's end. */
function ledgerQueries(source: string): string[] {
  return source
    .split("FROM transactions")
    .slice(1)
    .map((segment) => segment.split("`")[0]);
}

describe("every built-in report query applies the investment exclusion", () => {
  const reportServices = readdirSync(join(SRC_ROOT, "built-in-reports"))
    .filter((f) => f.endsWith(".service.ts"))
    .map((f) => join(SRC_ROOT, "built-in-reports", f));

  it("finds the report services", () => {
    expect(reportServices.length).toBeGreaterThan(5);
  });

  it("applies it in the representation each query's shape needs", () => {
    const failures: string[] = [];

    for (const file of reportServices) {
      for (const query of ledgerQueries(readFileSync(file, "utf8"))) {
        const { missing } = classifyLedgerQuery(query);
        if (missing.length === 0) continue;
        failures.push(
          `${relative(SRC_ROOT, file)}: ${query.trim().split("\n")[0]} -- missing ${missing.join(", ")}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("never exempts a query that joins split rows", () => {
    // The shape F-GUARD-001 slipped through: a split-joining aggregate that
    // mentions `is_transfer = true` in an OR branch is not transfer-only.
    const exempted: string[] = [];

    for (const file of reportServices) {
      for (const query of ledgerQueries(readFileSync(file, "utf8"))) {
        if (!/JOIN transaction_splits/.test(query)) continue;
        const { shape } = classifyLedgerQuery(query);
        if (shape !== "split-aware") {
          exempted.push(
            `${relative(SRC_ROOT, file)}: ${query.trim().split("\n")[0]} -- classified ${shape}`,
          );
        }
      }
    }

    expect(exempted).toEqual([]);
  });

  it("scans both shapes, so neither branch is vacuous", () => {
    const shapes = new Set<QueryShape>();
    for (const file of reportServices) {
      for (const query of ledgerQueries(readFileSync(file, "utf8"))) {
        shapes.add(classifyLedgerQuery(query).shape);
      }
    }

    expect(shapes.has("split-aware")).toBe(true);
    expect(shapes.has("parent-only")).toBe(true);
  });
});

/**
 * The classifier's own negative controls. The real-source scan above can only
 * say "nothing is wrong today"; these say the scan would notice.
 */
describe("classifyLedgerQuery", () => {
  const PARENT_ONLY = `
      SELECT SUM(ABS(t.amount)) FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND \${INVESTMENT_EXCLUSION_NO_SPLITS}
  `;

  it("flags a parent-only query that reads t.amount with transaction-only provenance", () => {
    const { shape, missing } = classifyLedgerQuery(PARENT_ONLY);

    expect(shape).toBe("parent-only");
    expect(missing).toEqual([
      "a reportable-amount derivation (reads t.amount on a parent)",
    ]);
  });

  it("accepts the same query once it derives the reportable amount", () => {
    const fixed = PARENT_ONLY.replace(
      "SUM(ABS(t.amount))",
      "SUM(ABS(${REPORTABLE_TX_AMOUNT}))",
    );

    expect(classifyLedgerQuery(fixed).missing).toEqual([]);
  });

  it("flags a split-joining query that downgrades to the no-splits variant", () => {
    const query = `
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      WHERE t.user_id = $1
        AND \${INVESTMENT_EXCLUSION_NO_SPLITS}
    `;

    const { shape, missing } = classifyLedgerQuery(query);

    expect(shape).toBe("split-aware");
    expect(missing).toEqual(["the split-aware INVESTMENT_EXCLUSION"]);
  });

  it("does not exempt a mixed predicate that merely mentions a transfer", () => {
    // The real monthly-category-breakdown shape: ordinary rows plus categorized
    // transfer outflows, joined to splits.
    const query = `
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      WHERE t.user_id = $1
        AND (
          t.is_transfer = false
          OR (t.is_transfer = true AND t.category_id IS NOT NULL AND t.amount < 0)
        )
    `;

    const { shape, missing } = classifyLedgerQuery(query);

    expect(shape).toBe("split-aware");
    expect(missing).toEqual(["the split-aware INVESTMENT_EXCLUSION"]);
  });

  it("exempts a transfer-only rollup", () => {
    const query = `
      FROM transactions t
      WHERE t.user_id = $1 AND t.is_transfer = true
    `;

    expect(classifyLedgerQuery(query)).toEqual({
      shape: "transfer-only",
      missing: [],
    });
  });

  it("exempts a declared parent-identity report, but still wants an exclusion", () => {
    const declared = `${PARENT_ONLY}\n-- PARENT-IDENTITY REPORT: stored row, not its cash meaning`;

    expect(classifyLedgerQuery(declared)).toEqual({
      shape: "parent-identity",
      missing: [],
    });
    expect(
      classifyLedgerQuery(
        "FROM transactions t -- PARENT-IDENTITY REPORT: no exclusion at all",
      ).missing,
    ).toEqual(["an investment exclusion"]);
  });
});

/**
 * The register of what INV-REPORT-001 does NOT yet cover, which is why the
 * invariant's status is `partial` rather than `enforced`.
 *
 * `backend/src/reports/` executes user-defined custom reports over the same
 * ledger through hydrated TypeORM entities, and applies no investment
 * provenance at all: a free-standing BUY's generated cash leg is reported as
 * `Uncategorized` spending, and an embedded investment split child is counted
 * beside its ordinary sibling (re-audit F-CUSTOM-001). The behaviour predates
 * the #1257 work and is unchanged by it.
 *
 * The pin is written so it fails when the gap CLOSES: whoever migrates that
 * engine gets a red test naming the document to update, so the catalog cannot
 * keep describing a gap that is gone.
 */
describe("known gap: the custom report engine", () => {
  const CUSTOM_REPORTS = join(SRC_ROOT, "reports", "reports.service.ts");
  const PROVENANCE_MARKERS = [
    "investment_transactions",
    "applyInvestmentTransactionFilters",
    "investmentExclusionSql",
    "reportableTransactionAmountSql",
  ];

  it("still applies no investment provenance -- keep INV-REPORT-001 at `partial` until it does", () => {
    const source = readFileSync(CUSTOM_REPORTS, "utf8");
    const applied = PROVENANCE_MARKERS.filter((marker) =>
      source.includes(marker),
    );

    // When this fails because `applied` is no longer empty: the gap is closed.
    // Update INV-REPORT-001 in docs/system-invariants.md to `enforced`, name the
    // custom-report tests that prove it, and delete this block.
    expect(applied).toEqual([]);
  });
});
