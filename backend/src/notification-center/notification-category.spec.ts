/**
 * The notification type partition, and the one thing that must stay derived.
 *
 * `notificationCategoryOf` answers "what is this notification about" from
 * `alert_type` alone. That is a design decision, not an implementation detail:
 * a stored `category` column would be a second answer to the same question,
 * true only while every producer remembers to write it -- and the raw
 * `INSERT INTO notifications` in `budgets/budget-alert.service.ts` names its
 * columns, so it would have inherited whatever default the column carried. So
 * the absence of the column is asserted here, against `schema.sql`, rather than
 * left as a paragraph in the migration.
 */
import * as fs from "fs";
import * as path from "path";

import {
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  SYSTEM_NOTIFICATION_TYPES,
  notificationCategoryOf,
  typesForCategory,
  severityRank,
} from "./entities/notification.entity";
import {
  DEDUPE_KEY_MAX_LENGTH,
  TARGET_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./notification.service";

const SCHEMA_SQL = path.join(__dirname, "../../../database/schema.sql");

/** The `CREATE TABLE notifications (...)` body, as written in schema.sql. */
function notificationsTableSql(): string {
  const sql = fs.readFileSync(SCHEMA_SQL, "utf8");
  const start = sql.indexOf("CREATE TABLE notifications (");
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("\n);", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** The declared length of a `VARCHAR(n)` column in that table. */
function varcharLength(column: string): number {
  const match = new RegExp(`^\\s*${column}\\s+VARCHAR\\((\\d+)\\)`, "im").exec(
    notificationsTableSql(),
  );
  expect(match).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

const ALL_TYPES = Object.values(NotificationType);

describe("notification type partition", () => {
  it("every type fits the alert_type column", () => {
    const limit = varcharLength("alert_type");
    const tooLong = ALL_TYPES.filter((t) => t.length > limit);
    expect(tooLong).toEqual([]);
  });

  it("every severity fits the severity column", () => {
    const limit = varcharLength("severity");
    const tooLong = Object.values(NotificationSeverity).filter(
      (s) => s.length > limit,
    );
    expect(tooLong).toEqual([]);
  });

  it("the system list holds real types, once each", () => {
    expect(new Set(SYSTEM_NOTIFICATION_TYPES).size).toBe(
      SYSTEM_NOTIFICATION_TYPES.length,
    );
    const unknown = SYSTEM_NOTIFICATION_TYPES.filter(
      (t) => !ALL_TYPES.includes(t),
    );
    expect(unknown).toEqual([]);
  });

  /**
   * Two classifications of one type now travel to the client: the fine
   * `category` a per-category preference will key on, and the coarse
   * system-vs-financial split the list's filter and the dismiss-all command
   * already use. Both derive from `SYSTEM_NOTIFICATION_TYPES`, so they cannot
   * drift by accident -- but `notificationCategoryOf` checks BILL_DUE FIRST, so
   * a type added to the system set that the function special-cases earlier would
   * be SYSTEM to one reader and financial to the other, and a filtered
   * delete-all would remove rows the filter never showed.
   */
  it("agrees with the coarse split the filters use", () => {
    for (const type of ALL_TYPES) {
      const fine = notificationCategoryOf(type) === NotificationCategory.SYSTEM;
      const coarse = SYSTEM_NOTIFICATION_TYPES.includes(type);
      expect({ type, fine }).toEqual({ type, fine: coarse });
    }
  });

  it("categorizes every type, and only into declared categories", () => {
    const categories = Object.values(NotificationCategory);
    const uncategorized = ALL_TYPES.filter(
      (t) => !categories.includes(notificationCategoryOf(t)),
    );
    expect(uncategorized).toEqual([]);
  });

  it("splits payments, system and budgets with no type in two of them", () => {
    const byCategory = {
      [NotificationCategory.PAYMENTS]: [] as NotificationType[],
      [NotificationCategory.BUDGETS]: [] as NotificationType[],
      [NotificationCategory.SYSTEM]: [] as NotificationType[],
    };
    for (const type of ALL_TYPES) {
      byCategory[notificationCategoryOf(type)].push(type);
    }

    expect(byCategory[NotificationCategory.PAYMENTS]).toEqual([
      NotificationType.BILL_DUE,
    ]);
    expect(byCategory[NotificationCategory.SYSTEM].sort()).toEqual(
      [...SYSTEM_NOTIFICATION_TYPES].sort(),
    );
    // Financial is defined as NOT IN the system list -- never a second list --
    // so this arm is what proves the two definitions describe one partition.
    expect(byCategory[NotificationCategory.BUDGETS].sort()).toEqual(
      ALL_TYPES.filter(
        (t) =>
          t !== NotificationType.BILL_DUE &&
          !SYSTEM_NOTIFICATION_TYPES.includes(t),
      ).sort(),
    );
  });

  it("typesForCategory is the exact inverse of notificationCategoryOf", () => {
    // The throttle window filters `notifications` by the types a category
    // expands to, so a reverse mapping that disagreed with the forward one
    // would throttle the wrong rows. Prove the round trip in both directions:
    // every type is in exactly its own category's set, and each set contains
    // only types that map back to it.
    for (const category of Object.values(NotificationCategory)) {
      const types = typesForCategory(category);
      expect(new Set(types).size).toBe(types.length); // no duplicates
      for (const type of types) {
        expect(notificationCategoryOf(type)).toBe(category);
      }
    }
    // Union over the categories is every type exactly once (a partition).
    const union = Object.values(NotificationCategory)
      .flatMap((category) => typesForCategory(category))
      .sort();
    expect(union).toEqual([...ALL_TYPES].sort());
  });

  it("severityRank is a strict escalation order", () => {
    // The throttle's escalation exception ranks a critical above a warning
    // above the rest; success is a positive milestone, never an escalation of a
    // warning, so it sits below them.
    expect(severityRank(NotificationSeverity.INFO)).toBeLessThan(
      severityRank(NotificationSeverity.SUCCESS),
    );
    expect(severityRank(NotificationSeverity.SUCCESS)).toBeLessThan(
      severityRank(NotificationSeverity.WARNING),
    );
    expect(severityRank(NotificationSeverity.WARNING)).toBeLessThan(
      severityRank(NotificationSeverity.CRITICAL),
    );
  });

  /**
   * The write door truncates on these three numbers, and truncating at the wrong
   * width is not a smaller version of the same behaviour: too low silently
   * shortens copy the column would have accepted, and too high hands PostgreSQL
   * a value it refuses with 22001 -- inside a producer's never-throws catch, so
   * the notification silently never exists. That is the exact failure the
   * truncation was written to prevent, which makes an unchecked constant the one
   * way to reintroduce it.
   */
  it.each([
    ["title", () => TITLE_MAX_LENGTH],
    ["dedupe_key", () => DEDUPE_KEY_MAX_LENGTH],
    ["target", () => TARGET_MAX_LENGTH],
  ])("the door's bound for %s is the column's own width", (column, bound) => {
    expect(bound()).toBe(varcharLength(column));
  });

  it("has no stored category column to disagree with the derivation", () => {
    // Migration 172 deliberately does not add one; see its header. A column
    // here would make this function advisory, and the first producer to forget
    // it would file a budget alert under SYSTEM with nothing failing.
    expect(notificationsTableSql()).not.toMatch(/^\s*category\s+/im);
  });
});
