import { readFileSync } from "fs";
import { join } from "path";
import { gitListFiles } from "./repo-tree.util";
import {
  ACCOUNT_BALANCE_AS_OF_SQL,
  LEDGER_EXCLUDES_VOID,
  LEDGER_TOP_LEVEL_ONLY,
  ledgerBalanceJoin,
} from "./ledger-balance.sql";

/**
 * The as-of ledger balance means one thing, so it is spelled once.
 *
 * Four services wrote the same join out by hand and the copies had already
 * drifted. The scheduled loan bill (INV-LOAN-006) claims the debt it prices is
 * the same measurement the balances-as-of report shows, which holds only while
 * the predicates agree -- so a fifth hand-written copy is a defect, not a
 * style preference.
 *
 * The scan reads code, not prose: comments are blanked first (line numbers
 * preserved), or the paragraph above explaining the banned pattern would fail
 * the guard that bans it.
 */
const SOURCE_ROOT = join(__dirname, "..");

/**
 * The copies that predate the shared fragment. **This list may only shrink.**
 *
 * Every one of these is the same measurement -- opening balance plus the
 * account's non-VOID, top-level rows -- reached by a different caller, some
 * scoping the join by `user_id` and some not. Converting them is a change to
 * how eight surfaces read a balance and belongs in its own review; what this
 * guard buys today is that the count cannot grow while they wait.
 */
const GRANDFATHERED = new Set([
  "accounts/accounts.service.ts",
  "accounts/account-balances-report.service.ts",
  "accounts/balance-forecast.service.ts",
  "accounts/statement-cycle.service.ts",
  "action-history/action-history.service.ts",
  "delegation/joint-accounts.service.ts",
  "import/import-post-processing.service.ts",
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

describe("as-of ledger balance SQL", () => {
  it("blanks comments while preserving line numbers", () => {
    const stripped = stripComments("a\n// t.parent_transaction_id IS NULL\nb");
    expect(stripped.split("\n")).toHaveLength(3);
    expect(stripped).not.toContain("parent_transaction_id");
    expect(stripComments("keep t.parent_transaction_id IS NULL")).toContain(
      "parent_transaction_id",
    );
  });

  it("composes the documented predicates", () => {
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain(LEDGER_EXCLUDES_VOID);
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain(LEDGER_TOP_LEVEL_ONLY);
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain("t.transaction_date <= $3");
    expect(ledgerBalanceJoin("$2", ["t.user_id = $1"])).toContain(
      "AND t.user_id = $1",
    );
  });

  it("has no new hand-written copy of the join", () => {
    const offenders: string[] = [];
    for (const relative of gitListFiles(SOURCE_ROOT)) {
      if (!relative.endsWith(".ts") || relative.endsWith(".spec.ts")) continue;
      if (relative === "common/ledger-balance.sql.ts") continue;
      if (GRANDFATHERED.has(relative)) continue;
      const source = stripComments(
        readFileSync(join(SOURCE_ROOT, relative), "utf8"),
      );
      // The fingerprint of the join: the split-child exclusion beside a
      // transactions join. Either alone is ordinary; together they are a
      // balance being summed.
      if (
        source.includes("parent_transaction_id IS NULL") &&
        /LEFT JOIN\s+transactions/i.test(source)
      ) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the grandfather list honest -- every entry still holds a copy", () => {
    // A stale exemption is how a guard quietly stops guarding: an entry whose
    // copy is gone would keep a converted file exempt forever.
    const stale = [...GRANDFATHERED].filter((relative) => {
      const source = stripComments(
        readFileSync(join(SOURCE_ROOT, relative), "utf8"),
      );
      return !(
        source.includes("parent_transaction_id IS NULL") &&
        /LEFT JOIN\s+transactions/i.test(source)
      );
    });
    expect(stale).toEqual([]);
  });
});
