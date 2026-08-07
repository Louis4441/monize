import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

/**
 * Source-scanning guards for two of the mistakes the Phase 4 concurrency audit
 * found over and over, in different files, each time looking locally reasonable.
 *
 * A rule in prose gets read, agreed with, and violated anyway -- so these are
 * tests. They scan the source rather than exercising behaviour, because both
 * mistakes are mechanical: not "this calculation is wrong" but "this shape is the
 * wrong shape", and the next instance will be in a file nobody thought to check.
 *
 * Each list below is an allowlist of *reviewed* exceptions. An entry needs a
 * reason, and the list may only shrink.
 */
const SRC = join(__dirname, "..", "..");

function sourceFiles(): string[] {
  return globSync("**/*.ts", {
    cwd: SRC,
    absolute: true,
    ignore: ["**/*.spec.ts", "**/*.d.ts", "**/node_modules/**"],
  });
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function relative(file: string): string {
  return file.slice(SRC.length + 1).replace(/\\/g, "/");
}

describe("derived financial state has one set of writers", () => {
  /**
   * A balance reversal must be gated on the row this call actually removed.
   *
   * `manager.remove(entity)` deletes by primary key and reports nothing, so two
   * concurrent removals each reversed the same amount while one row went away --
   * and it reversed whatever the *snapshot* held, and reversed it even for a VOID
   * row that had contributed nothing. That is four separate mistakes in one
   * four-line shape, which is why it survived three fixes and reappeared a fourth
   * time in split removal (audit FV4-002).
   *
   * `removeLockedTransactionLeg` is the whole sequence in one place. This scan
   * fails on any *new* file that reverses a balance with a bare `remove()` beside
   * it -- the mistake is mechanical, so the guard is a scan and not a review note.
   */
  it("removes a ledger row conditionally wherever it reverses a balance", () => {
    const ALLOWED = new Map([
      [
        "securities/investment-transactions.service.ts",
        "reverseTransactionEffectsInTransaction reverses HOLDINGS under the " +
          "holdings advisory lock, not accounts.current_balance from a ledger " +
          "snapshot; its cash-leg deletions already read affectedRowCount",
      ],
      [
        "import/import-post-processing.service.ts",
        "recomputes balances absolutely under the shared account lock after an " +
          "import; there is no per-row delta to gate",
      ],
    ]);

    const offenders = sourceFiles()
      .filter((file) => {
        const source = read(file);
        // A file that reverses a ledger row's contribution to a balance.
        if (!/accountsService\.updateBalance\(/.test(source)) return false;
        // ...and still deletes a transaction-shaped row by entity identity.
        return /\b(?:m|manager|txRepo|repo)\s*\.\s*remove\s*\(\s*(?!allSplits|splits\b)\w*(?:[Tt]ransaction|[Ll]eg|[Tt]x)\w*\s*[,)]/.test(
          source,
        );
      })
      .map(relative)
      .filter((file) => !ALLOWED.has(file));

    expect(offenders).toEqual([]);
  });

  /**
   * `ActionHistoryService.record` swallows its own failures on purpose: recording
   * an undo entry must never fail the operation the user actually asked for. That
   * is only safe *outside* a transaction. Called inside one, a failed insert has
   * already aborted the caller's transaction, and swallowing the error hides it
   * until the next statement dies with `25P02 in_failed_sql_transaction` -- so
   * the user's write fails, with a message about the audit trail.
   *
   * Nothing about the call site says which side of the boundary it is on, which is
   * exactly the kind of mistake prose does not prevent. Currently zero call sites
   * are inside a transaction; this keeps it that way.
   */
  it("records action history outside the caller's transaction, never inside it", () => {
    /** The body of each `withScopedDb(...)` call in a file, by paren matching. */
    function scopedDbCallbacks(source: string): string[] {
      const bodies: string[] = [];
      for (const match of source.matchAll(/withScopedDb\s*\(/g)) {
        let depth = 0;
        let i = match.index! + match[0].length - 1;
        const start = i;
        while (i < source.length) {
          if (source[i] === "(") depth++;
          else if (source[i] === ")" && --depth === 0) break;
          i++;
        }
        bodies.push(source.slice(start, i));
      }
      return bodies;
    }

    const offenders = sourceFiles()
      .filter((file) =>
        scopedDbCallbacks(read(file)).some((body) =>
          /\bactionHistory\w*\s*\.\s*record\s*\(/.test(body),
        ),
      )
      .map(relative);

    expect(offenders).toEqual([]);
  });
});
