/**
 * The `notifications` table has one writer.
 *
 * Before `NotificationService` existed there were three, with three different
 * opinions: a raw `INSERT` for budget alerts (its own conflict target, no title
 * bound), an entity `save` for bill reminders (no conflict handling at all), and
 * a second raw `INSERT` for system alerts (its own truncation helpers and its
 * own `period_start` default). Every rule the row has to obey therefore held on
 * one path and not the others -- an over-long scheduled-transaction name raised
 * 22001 inside a never-throws catch on one of them, and the notification the
 * user needed silently never existed.
 *
 * A producer decides *what* to say. What the row looks like is not its decision,
 * so this scan fails on a second writer.
 *
 * Reads are deliberately not restricted: a producer's de-duplication query is
 * about that producer's own candidates, not about the reader's list, and
 * pretending otherwise would put budget logic in this module.
 */
import * as fs from "fs";
import * as path from "path";

import { gitListFiles } from "../common/repo-tree.util";

const SRC = path.join(__dirname, "..");

/**
 * Files allowed to write the table, each for a reason that is not "it produces
 * notifications".
 */
const WRITE_ALLOWLIST: Readonly<Record<string, string>> = {
  "notification-center/notification.service.ts":
    "the door itself -- every producer goes through it",
  "users/users.service.ts":
    "delete-my-data erases every table this account owns, notifications included",
  "backup/backup-restore-database.service.ts":
    "a restore replaces every table this account owns before re-inserting",
};

/**
 * Comments blanked, line count preserved, so the prose above -- which has to
 * name the very patterns this scan bans -- cannot trip it, and an offender
 * report still points at the right line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Every write shape, as `label -> pattern`. */
const WRITE_PATTERNS: Readonly<Record<string, RegExp>> = {
  "raw INSERT": /INSERT\s+INTO\s+notifications\b/gi,
  "raw UPDATE": /UPDATE\s+notifications\b/gi,
  "raw DELETE": /DELETE\s+FROM\s+notifications\b/gi,
  "repository write":
    /getRepository\(\s*Notification\s*\)\s*(?:\r?\n\s*)?\.\s*(save|insert|update|delete|remove|upsert)\b/g,
};

/**
 * Every tracked TypeScript source under `src/`, as a path relative to it.
 *
 * `git ls-files`, so the scan sees exactly the tree CI sees -- which also means
 * a brand-new file is invisible until it is staged (`git add -N` is enough).
 */
function sourceFiles(): string[] {
  return gitListFiles(SRC)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".spec.ts"));
}

describe("the notifications table has one writer", () => {
  it("finds the door, so the scan is not passing vacuously", () => {
    const door = fs.readFileSync(
      path.join(SRC, "notification-center/notification.service.ts"),
      "utf8",
    );
    expect(stripComments(door)).toMatch(WRITE_PATTERNS["raw INSERT"]);
  });

  it("no other file writes it", () => {
    const offenders: string[] = [];
    for (const relative of sourceFiles()) {
      if (relative in WRITE_ALLOWLIST) continue;
      const source = stripComments(
        fs.readFileSync(path.join(SRC, relative), "utf8"),
      );
      for (const [label, pattern] of Object.entries(WRITE_PATTERNS)) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index ?? 0).split("\n").length;
          offenders.push(`${relative}:${line} ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlisted file exists and still writes the table", () => {
    // An entry that stopped writing is an entry that should be removed: left
    // behind, it is a standing permission nobody is using and the next writer
    // in that file inherits it.
    for (const [relative, reason] of Object.entries(WRITE_ALLOWLIST)) {
      const absolute = path.join(SRC, relative);
      expect(fs.existsSync(absolute)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
      const source = stripComments(fs.readFileSync(absolute, "utf8"));
      const writes = Object.values(WRITE_PATTERNS).some((pattern) =>
        new RegExp(pattern.source, pattern.flags).test(source),
      );
      expect(writes).toBe(true);
    }
  });

  it("blanks comments in both directions", () => {
    // A scan that prose can trip is also a scan that prose can satisfy, so the
    // stripper is tested rather than trusted.
    const banned = "INSERT INTO notifications";
    expect(stripComments(`// ${banned}\nconst a = 1;`)).not.toContain(banned);
    expect(stripComments(`/* ${banned} */\nconst a = 1;`)).not.toContain(
      banned,
    );
    expect(stripComments(`const sql = "${banned}";`)).toContain(banned);
    // Line numbers survive, so an offender report points at the right line.
    const source = `// x\n/* y\n z */\nconst a = 1;`;
    expect(stripComments(source).split("\n")).toHaveLength(
      source.split("\n").length,
    );
  });
});
