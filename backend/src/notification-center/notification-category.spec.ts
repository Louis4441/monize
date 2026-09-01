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
} from "./entities/notification.entity";

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

  it("has no stored category column to disagree with the derivation", () => {
    // Migration 172 deliberately does not add one; see its header. A column
    // here would make this function advisory, and the first producer to forget
    // it would file a budget alert under SYSTEM with nothing failing.
    expect(notificationsTableSql()).not.toMatch(/^\s*category\s+/im);
  });
});
