import { CronExpression } from "@nestjs/schedule";
import { readFileSync } from "fs";
import { basename, join } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * `docs/cron-jobs.md` is where `backend/CLAUDE.md` sends anyone asking what runs
 * on a schedule. It was missing six of them -- including `auto-backup.service`,
 * the subject of the very audit phase that led here -- and listed one
 * (`auth.service`) whose `@Cron` had moved to `token.service`.
 *
 * That is not a cosmetic gap. Every `@Cron` handler is an out-of-request entry
 * point that has to seed its own RLS context, every replica fires every cron, and
 * several of them send email or grant access. An operator reading the table would
 * not have learned that automatic backups, emergency-access escalation or the
 * matured-holdings rebuild happen at all.
 *
 * So the table is checked against the source, and not for membership only: each
 * row carries the handler's cron expression verbatim in the Cron column, and the
 * suite compares those expressions -- timezone included -- against the decorators.
 * Membership alone once let the table claim `accounts.service` ran at midnight
 * while the decorator said hourly; an expression the machine compares cannot
 * drift like prose can.
 *
 * The unit is the handler: one row per `@Cron`, so a service that quietly grows
 * a second schedule fails the suite. Handlers are keyed by file stem
 * (`auto-backup.service`), aggregated across files -- two files sharing a stem
 * both count, instead of the second silently overwriting the first -- and the
 * stem grammar does not require `.service`, so a handler that ever lands outside
 * a `*.service.ts` file can be documented rather than making the suite
 * unsatisfiable. A decorator the parser cannot read (a variable, a template
 * literal) is a loud failure listing the file, never a silently missing row.
 */

/** `expression` plus the timezone option, rendered the way the doc writes it. */
const renderSchedule = (expression: string, timeZone?: string): string =>
  timeZone ? `${expression} (${timeZone})` : expression;

const CRON_DECORATOR =
  /@Cron\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|CronExpression\.([A-Za-z0-9_]+))\s*(?:,\s*\{([^}]*)\})?\s*\)/g;

export interface ParsedCrons {
  /** Rendered schedules, one per parsed decorator. */
  schedules: string[];
  /** Decorator lines the source declares, parseable or not. */
  anchors: number;
  /** Decorators the grammar could not resolve, with the reason. */
  problems: string[];
}

/**
 * Extract every `@Cron` decorator from one file's source. Pure, so the grammar
 * is unit-tested below. `anchors` counts decorator lines independently of the
 * parse; a caller failing on `anchors !== schedules.length` turns "the parser
 * missed one" into a red test naming the file instead of a missing row nobody
 * notices.
 */
export function parseCronDecorators(source: string): ParsedCrons {
  const schedules: string[] = [];
  const problems: string[] = [];
  for (const match of source.matchAll(CRON_DECORATOR)) {
    const [, doubleQuoted, singleQuoted, enumName, options] = match;
    let expression = doubleQuoted ?? singleQuoted;
    if (enumName !== undefined) {
      const resolved = (CronExpression as Record<string, string>)[enumName];
      if (!resolved) {
        problems.push(`CronExpression.${enumName} is not a known expression`);
        continue;
      }
      expression = resolved;
    }
    const timeZone = options
      ? /timeZone:\s*["']([^"']+)["']/.exec(options)?.[1]
      : undefined;
    schedules.push(renderSchedule(expression as string, timeZone));
  }
  const anchors = (source.match(/^\s*@Cron\(/gm) ?? []).length;
  return { schedules, anchors, problems };
}

export interface StemSchedules {
  files: string[];
  schedules: string[];
}

/**
 * Key parsed files by their stem (`auto-backup.service`), aggregating across
 * files: two files sharing a stem both contribute, instead of the second
 * silently overwriting the first.
 */
export function aggregateByStem(
  files: { path: string; schedules: string[] }[],
): Map<string, StemSchedules> {
  const byStem = new Map<string, StemSchedules>();
  for (const file of files) {
    if (file.schedules.length === 0) continue;
    const stem = basename(file.path).replace(/\.ts$/, "");
    const existing = byStem.get(stem) ?? { files: [], schedules: [] };
    byStem.set(stem, {
      files: [...existing.files, file.path],
      schedules: [...existing.schedules, ...file.schedules],
    });
  }
  return byStem;
}

/**
 * Rows of the schedule table: first column the stem, second the expression --
 * any stem, not just `*.service`, so nothing representable in the source is
 * unrepresentable in the doc.
 */
export function parseCronDocRows(
  markdown: string,
): { stem: string; schedule: string }[] {
  return [
    ...markdown.matchAll(
      /^\|\s*`([a-z0-9][a-z0-9.-]*)`\s*\|\s*`([^`\n]+)`(?:\s*\(([^)\n]+)\))?\s*\|/gm,
    ),
  ].map(([, stem, expression, timeZone]) => ({
    stem,
    schedule: renderSchedule(expression, timeZone),
  }));
}

/**
 * Per-stem comparison of documented against declared schedules, as sorted
 * multisets. Returns human-readable discrepancies; empty means the table tells
 * the truth.
 */
export function scheduleDiscrepancies(
  declared: Map<string, StemSchedules>,
  documented: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const [stem, { schedules }] of declared) {
    const doc = documented.get(stem);
    if (!doc) continue; // membership is its own test with its own message
    const want = [...schedules].sort();
    const have = [...doc].sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      out.push(
        `${stem}: source declares [${want.join("; ")}], doc says [${have.join("; ")}]`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The grammar, pinned.
// ---------------------------------------------------------------------------

describe("cron doc grammar", () => {
  it("parses literal expressions, options and timezones", () => {
    const parsed = parseCronDecorators(
      [
        `  @Cron("0 17 * * 1-5", { timeZone: "America/New_York" })`,
        `  async prices() {}`,
        `  @Cron('30 * * * *')`,
        `  async holdings() {}`,
      ].join("\n"),
    );
    expect(parsed.schedules).toEqual([
      "0 17 * * 1-5 (America/New_York)",
      "30 * * * *",
    ]);
    expect(parsed.anchors).toBe(2);
    expect(parsed.problems).toEqual([]);
  });

  it("resolves CronExpression members through the installed enum", () => {
    // Resolved via the import, so the doc tracks the scheduler actually
    // running, not a copy of its values.
    const parsed = parseCronDecorators(
      `  @Cron(CronExpression.EVERY_DAY_AT_6AM)`,
    );
    expect(parsed.schedules).toEqual([CronExpression.EVERY_DAY_AT_6AM]);
    expect(
      parseCronDecorators(`  @Cron(CronExpression.NO_SUCH_MEMBER)`).problems,
    ).toHaveLength(1);
  });

  it("counts a decorator it cannot parse, so the mismatch is loud", () => {
    // A template literal (or a variable) is outside the grammar: anchors sees
    // it, schedules does not, and the tree test below fails naming the file.
    const parsed = parseCronDecorators("  @Cron(`0 4 * * *`)\n  async x() {}");
    expect(parsed.anchors).toBe(1);
    expect(parsed.schedules).toEqual([]);
  });

  it("aggregates two files sharing a stem instead of dropping one", () => {
    // Keying a plain object by stem let the second file silently overwrite the
    // first; both of these must survive.
    const byStem = aggregateByStem([
      { path: "backend/src/auth/token.service.ts", schedules: ["0 03 * * *"] },
      { path: "backend/src/other/token.service.ts", schedules: ["0 * * * *"] },
    ]);
    expect(byStem.get("token.service")).toEqual({
      files: [
        "backend/src/auth/token.service.ts",
        "backend/src/other/token.service.ts",
      ],
      schedules: ["0 03 * * *", "0 * * * *"],
    });
  });

  it("accepts a documented stem that is not a .service", () => {
    // The old row grammar required `.service`, so a handler in any other file
    // made the suite unsatisfiable: no legal row could ever document it.
    const rows = parseCronDocRows(
      "| `report.task` | `0 1 * * *` | Daily 1 AM | Nightly report |",
    );
    expect(rows).toEqual([{ stem: "report.task", schedule: "0 1 * * *" }]);
  });

  it("reads a timezone-qualified doc row back to the rendered form", () => {
    const rows = parseCronDocRows(
      "| `exchange-rate.service` | `5 17 * * 1-5` (America/New_York) | 5:05 PM ET weekdays | Fetch rates |",
    );
    expect(rows[0].schedule).toBe("5 17 * * 1-5 (America/New_York)");
  });

  it("reports a documented schedule that contradicts the decorator", () => {
    // The regression this suite exists to catch: the table said midnight
    // daily, the decorator said hourly, and a membership-only check was happy.
    const declared = new Map([
      [
        "accounts.service",
        { files: ["accounts.service.ts"], schedules: ["0 * * * *"] },
      ],
    ]);
    const documented = new Map([["accounts.service", ["0 0 * * *"]]]);
    expect(scheduleDiscrepancies(declared, documented)).toEqual([
      "accounts.service: source declares [0 * * * *], doc says [0 0 * * *]",
    ]);
    expect(
      scheduleDiscrepancies(
        declared,
        new Map([["accounts.service", ["0 * * * *"]]]),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tree itself.
// ---------------------------------------------------------------------------

const REPO_ROOT = findRepoRoot(__dirname);

const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree(
  "docs/cron-jobs.md matches the @Cron handlers in the source",
  () => {
    interface TreeData {
      declared: Map<string, StemSchedules>;
      unparseable: string[];
      documented: Map<string, string[]>;
      rowCount: number;
    }
    let cached: TreeData | undefined;

    const load = (): TreeData => {
      if (cached) return cached;
      const root = requireRepoRoot(REPO_ROOT);
      const sources = gitListFiles(root, "-- backend/src").filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"),
      );
      const unparseable: string[] = [];
      const parsedFiles = sources.map((path) => {
        const parsed = parseCronDecorators(
          readFileSync(join(root, path), "utf8"),
        );
        if (
          parsed.anchors !== parsed.schedules.length ||
          parsed.problems.length
        ) {
          unparseable.push(
            `${path}: ${parsed.anchors} @Cron line(s), ${parsed.schedules.length} parsed${
              parsed.problems.length ? `; ${parsed.problems.join("; ")}` : ""
            }`,
          );
        }
        return { path, schedules: parsed.schedules };
      });
      const declared = aggregateByStem(parsedFiles);
      const rows = parseCronDocRows(
        readFileSync(join(root, "docs", "cron-jobs.md"), "utf8"),
      );
      const documented = new Map<string, string[]>();
      for (const { stem, schedule } of rows) {
        documented.set(stem, [...(documented.get(stem) ?? []), schedule]);
      }
      cached = { declared, unparseable, documented, rowCount: rows.length };
      return cached;
    };

    it("finds handlers and rows at all, so the comparisons are not vacuous", () => {
      // Either side reading empty would make every assertion below pass.
      const { declared, documented, rowCount } = load();
      expect(declared.size).toBeGreaterThan(10);
      expect(documented.size).toBeGreaterThan(10);
      expect(rowCount).toBeGreaterThanOrEqual(20);
      expect(declared.has("auto-backup.service")).toBe(true);
    });

    it("parses every @Cron decorator it counts", () => {
      // A decorator outside the grammar must be a red test naming the file, not
      // a row that quietly never gets demanded.
      expect(load().unparseable).toEqual([]);
    });

    it("documents every service that declares a @Cron handler", () => {
      const { declared, documented } = load();
      const undocumented = [...declared.keys()]
        .filter((stem) => !documented.has(stem))
        .sort();
      // A scheduled job nobody knows about is one nobody checks the RLS context,
      // the multi-replica behaviour or the failure mode of.
      expect(undocumented).toEqual([]);
    });

    it("names no service that has stopped having one", () => {
      const { declared, documented } = load();
      const stale = [...documented.keys()]
        .filter((stem) => !declared.has(stem))
        .sort();
      // `auth.service` sat here after its @Cron moved to `token.service`, so the
      // table pointed at a file with no schedule in it.
      expect(stale).toEqual([]);
    });

    it("documents each handler's exact expression, timezone included", () => {
      // One row per handler, expression compared verbatim: this is what stops
      // the table claiming midnight for an hourly job, or reading complete when
      // a service quietly grew a second schedule.
      const { declared, documented } = load();
      expect(scheduleDiscrepancies(declared, documented)).toEqual([]);
    });
  },
);
