import { NotFoundException } from "@nestjs/common";
import { In, IsNull, Not } from "typeorm";

import {
  LIST_PAGE_SIZE,
  NotificationService,
  RETENTION_DAYS,
  TITLE_MAX_LENGTH,
  DEDUPE_KEY_MAX_LENGTH,
  TARGET_MAX_LENGTH,
} from "./notification.service";
import {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  SYSTEM_NOTIFICATION_TYPES,
} from "./entities/notification.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: (_userId: string, fn: () => unknown) => fn(),
}));

function row(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n-1",
    userId: "user-1",
    budgetId: null,
    budget: null,
    budgetCategoryId: null,
    budgetCategory: null,
    type: NotificationType.THRESHOLD_WARNING,
    severity: NotificationSeverity.WARNING,
    title: "Groceries at 80%",
    message: "You have spent 80% of your groceries budget",
    data: {},
    target: null,
    isRead: false,
    isEmailSent: false,
    periodStart: "2026-02-01",
    createdAt: new Date("2026-02-15"),
    dismissedAt: null,
    dedupeKey: null,
    ...overrides,
  };
}

describe("NotificationService", () => {
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let notifications: Record<string, jest.Mock>;
  let preferences: { resolveThrottleMinutes: jest.Mock };
  let service: NotificationService;

  /** The INSERTs the door issued, as [sql, params]. */
  const inserts = () =>
    manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO notifications"),
    );

  /**
   * One insert's parameters keyed by the column the statement names, so an
   * assertion pins the column rather than a position in the writer's own
   * column order.
   */
  const inserted = (index = 0): Record<string, unknown> => {
    const [sql, params] = inserts()[index];
    const columns = /INSERT INTO notifications\s*\(([^)]*)\)/.exec(String(sql));
    if (!columns) throw new Error(`no column list in: ${String(sql)}`);
    return Object.fromEntries(
      columns[1]
        .split(",")
        .map((name, i) => [name.trim(), (params as unknown[])[i]]),
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    notifications = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((entity: unknown) => entity),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const mocks = createScopedDbMocks([[Notification, notifications]]);
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    manager.query.mockResolvedValue([{ id: "n-new" }]);
    // Throttle off by default: the throttle branch never runs, so every
    // existing create test exercises exactly today's path.
    preferences = { resolveThrottleMinutes: jest.fn().mockResolvedValue(0) };
    service = new NotificationService(
      dataSource as never,
      preferences as never,
    );
  });

  describe("create", () => {
    it("writes the row and returns the stored state, not the input", async () => {
      const stored = row({ id: "n-new" });
      notifications.findOne.mockResolvedValue(stored);

      const created = await service.create("user-1", {
        type: NotificationType.OVER_BUDGET,
        severity: NotificationSeverity.CRITICAL,
        title: "Groceries is over budget",
        message: "You have spent 120%",
        data: { budgeted: 500 },
        target: "/budgets/b-1",
        budgetId: "b-1",
        budgetCategoryId: "bc-1",
        periodStart: "2026-02-01",
      });

      // The defaults, the trigger-stamped timestamps and the truncations all
      // live in the database, so the caller is handed what was read back.
      expect(created).toBe(stored);
      expect(notifications.findOne).toHaveBeenCalledWith({
        where: { id: "n-new" },
      });
      expect(inserted()).toMatchObject({
        user_id: "user-1",
        budget_id: "b-1",
        budget_category_id: "bc-1",
        alert_type: NotificationType.OVER_BUDGET,
        severity: NotificationSeverity.CRITICAL,
        target: "/budgets/b-1",
        period_start: "2026-02-01",
      });
    });

    it("insert and read-back share one transaction", async () => {
      notifications.findOne.mockResolvedValue(row({ id: "n-new" }));

      await service.create("user-1", {
        type: NotificationType.BILL_DUE,
        severity: NotificationSeverity.INFO,
        title: "Netflix due",
        message: "15.99 due",
      });

      // Reading the row back in a second transaction would let another writer
      // dismiss or purge it in between, and the caller would email about a row
      // that no longer says what it says.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("reports a conflict as null rather than raising", async () => {
      // Every replica runs every cron, so losing the race is the normal case:
      // the loser holds no row and therefore sends nothing.
      manager.query.mockResolvedValue([]);

      await expect(
        service.create("user-1", {
          type: NotificationType.BACKUP_FAILED,
          severity: NotificationSeverity.CRITICAL,
          title: "Backup failed",
          message: "boom",
          dedupeKey: "BACKUP_FAILED:user-1:2026-08-30",
        }),
      ).resolves.toBeNull();
      expect(notifications.findOne).not.toHaveBeenCalled();
    });

    it("lets one conflict clause cover both unique indexes", async () => {
      notifications.findOne.mockResolvedValue(row({ id: "n-new" }));

      await service.create("user-1", {
        type: NotificationType.OVER_BUDGET,
        severity: NotificationSeverity.CRITICAL,
        title: "t",
        message: "m",
        budgetId: "b-1",
      });

      // Naming a conflict target would arbitrate one index and raise on the
      // other -- the fingerprint for a budget notification, the dedupe key for
      // a system one, and a producer does not know which applies.
      const [sql] = inserts()[0];
      expect(String(sql)).toContain("ON CONFLICT DO NOTHING");
      expect(String(sql)).toContain("RETURNING id");
    });

    it("defaults the period to today and leaves the optional columns null", async () => {
      notifications.findOne.mockResolvedValue(row({ id: "n-new" }));

      await service.create("user-1", {
        type: NotificationType.SMTP_FAILURE,
        severity: NotificationSeverity.CRITICAL,
        title: "SMTP failing",
        message: "boom",
      });

      const written = inserted();
      expect(written.period_start).toBe(new Date().toISOString().slice(0, 10));
      expect(written.budget_id).toBeNull();
      expect(written.budget_category_id).toBeNull();
      expect(written.target).toBeNull();
      expect(written.dedupe_key).toBeNull();
      expect(written.data).toBe("{}");
    });

    describe("column bounds", () => {
      beforeEach(() => {
        notifications.findOne.mockResolvedValue(row({ id: "n-new" }));
        jest
          .spyOn(service["logger"], "warn")
          .mockImplementation(() => undefined);
        jest
          .spyOn(service["logger"], "error")
          .mockImplementation(() => undefined);
      });

      // PostgreSQL raises 22001 on an over-long value, a producer's
      // never-throws catch swallows it, and the notification silently never
      // exists -- for SCHEDULED_POST_FAILED that means the user is never told
      // their money did not move.
      it("truncates an over-long title with an ellipsis", async () => {
        await service.create("user-1", {
          type: NotificationType.SCHEDULED_POST_FAILED,
          severity: NotificationSeverity.CRITICAL,
          title: `${"N".repeat(400)} could not be posted`,
          message: "m",
        });

        const title = String(inserted().title);
        expect(title).toHaveLength(TITLE_MAX_LENGTH);
        expect(title.endsWith("…")).toBe(true);
      });

      it("truncates an over-long dedupe key deterministically", async () => {
        const key = "K".repeat(DEDUPE_KEY_MAX_LENGTH + 40);

        await service.create("user-1", {
          type: NotificationType.BACKUP_FAILED,
          severity: NotificationSeverity.CRITICAL,
          title: "t",
          message: "m",
          dedupeKey: key,
        });

        expect(inserted().dedupe_key).toBe(key.slice(0, DEDUPE_KEY_MAX_LENGTH));
      });

      // A truncated path points somewhere else. Dropping the link is worse
      // than the right link and better than navigating to the wrong page.
      it("drops an over-long target rather than cutting it", async () => {
        await service.create("user-1", {
          type: NotificationType.BILL_DUE,
          severity: NotificationSeverity.INFO,
          title: "t",
          message: "m",
          target: `/scheduled-transactions/${"x".repeat(TARGET_MAX_LENGTH)}`,
        });

        expect(inserted().target).toBeNull();
      });

      it("leaves values inside the columns alone", async () => {
        await service.create("user-1", {
          type: NotificationType.BILL_DUE,
          severity: NotificationSeverity.INFO,
          title: "Netflix due tomorrow",
          message: "m",
          target: "/scheduled-transactions/st-1",
          dedupeKey: "BILL:st-1",
        });

        expect(inserted()).toMatchObject({
          title: "Netflix due tomorrow",
          target: "/scheduled-transactions/st-1",
          dedupe_key: "BILL:st-1",
        });
      });
    });
  });

  describe("throttle window", () => {
    // Dispatch manager.query by statement: the advisory lock, the in-window
    // severity probe, and the insert are three different reads.
    function wireQuery(inWindow: { severity: NotificationSeverity }[] = []) {
      manager.query.mockImplementation((sql: unknown) => {
        const text = String(sql);
        if (text.includes("pg_advisory_xact_lock"))
          return Promise.resolve([{}]);
        if (text.includes("SELECT severity FROM notifications"))
          return Promise.resolve(inWindow);
        if (text.includes("INSERT INTO notifications"))
          return Promise.resolve([{ id: "n-new" }]);
        return Promise.resolve([]);
      });
    }

    const budgetInput = (severity: NotificationSeverity) => ({
      type: NotificationType.THRESHOLD_WARNING, // BUDGETS category
      severity,
      title: "Groceries at 80%",
      message: "80%",
      budgetId: "b-1",
    });

    it("skips the throttle path entirely when the window is 0", async () => {
      preferences.resolveThrottleMinutes.mockResolvedValue(0);
      await service.create("user-1", budgetInput(NotificationSeverity.WARNING));
      const advisory = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("pg_advisory_xact_lock"),
      );
      expect(advisory).toHaveLength(0);
      expect(inserts()).toHaveLength(1);
    });

    it("takes a per-(user, category) advisory lock before probing", async () => {
      preferences.resolveThrottleMinutes.mockResolvedValue(15);
      wireQuery([]);
      await service.create("user-1", budgetInput(NotificationSeverity.WARNING));
      const advisory = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("pg_advisory_xact_lock"),
      );
      expect(advisory?.[1]).toEqual(["notif-throttle:user-1:BUDGETS"]);
    });

    it("delivers when nothing of the category is in the window", async () => {
      preferences.resolveThrottleMinutes.mockResolvedValue(15);
      wireQuery([]);
      notifications.findOne.mockResolvedValue(row({ id: "n-new" }));
      const created = await service.create(
        "user-1",
        budgetInput(NotificationSeverity.WARNING),
      );
      expect(created).not.toBeNull();
      expect(inserts()).toHaveLength(1);
    });

    it("suppresses a same-severity row already in the window", async () => {
      preferences.resolveThrottleMinutes.mockResolvedValue(15);
      wireQuery([{ severity: NotificationSeverity.WARNING }]);
      const created = await service.create(
        "user-1",
        budgetInput(NotificationSeverity.WARNING),
      );
      expect(created).toBeNull();
      expect(inserts()).toHaveLength(0);
    });

    it("suppresses a lower-severity row when the window holds a higher one", async () => {
      preferences.resolveThrottleMinutes.mockResolvedValue(15);
      wireQuery([{ severity: NotificationSeverity.CRITICAL }]);
      const created = await service.create(
        "user-1",
        budgetInput(NotificationSeverity.INFO),
      );
      expect(created).toBeNull();
      expect(inserts()).toHaveLength(0);
    });

    it("delivers a strictly higher-severity escalation of the same window", async () => {
      // A critical after a warning must get through -- silence on an escalation
      // is the dangerous direction.
      preferences.resolveThrottleMinutes.mockResolvedValue(15);
      wireQuery([{ severity: NotificationSeverity.WARNING }]);
      notifications.findOne.mockResolvedValue(
        row({ id: "n-new", severity: NotificationSeverity.CRITICAL }),
      );
      const created = await service.create(
        "user-1",
        budgetInput(NotificationSeverity.CRITICAL),
      );
      expect(created).not.toBeNull();
      expect(inserts()).toHaveLength(1);
    });

    it("probes the window over the category's alert types and the cutoff", async () => {
      preferences.resolveThrottleMinutes.mockResolvedValue(15);
      wireQuery([]);
      const before = Date.now();
      await service.create("user-1", budgetInput(NotificationSeverity.WARNING));
      const probe = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("SELECT severity FROM notifications"),
      );
      const [userId, types, cutoff] = probe?.[1] as [
        string,
        NotificationType[],
        Date,
      ];
      expect(userId).toBe("user-1");
      // BUDGETS expands to every non-bill, non-system type; BILL_DUE is not one.
      expect(types).toContain(NotificationType.THRESHOLD_WARNING);
      expect(types).not.toContain(NotificationType.BILL_DUE);
      expect(types).not.toContain(NotificationType.BACKUP_FAILED);
      // ~15 minutes before now.
      expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(
        15 * 60_000 - 50,
      );
    });
  });

  describe("markEmailSent", () => {
    it("sets the flag on that row alone", async () => {
      await service.markEmailSent("user-1", "n-1");

      const [sql, params] = manager.query.mock.calls[0];
      expect(String(sql)).toContain("SET is_email_sent = true");
      expect(params).toEqual(["n-1", "user-1"]);
    });

    // At RLS_MODE=off nothing outside this statement scopes it, so the owner has
    // to be IN it: an id-only UPDATE would flip whichever account's row carries
    // that id.
    it("restricts the update to the owner as well as the id", async () => {
      await service.markEmailSent("user-1", "n-1");

      const [sql] = manager.query.mock.calls[0];
      expect(String(sql)).toMatch(/WHERE\s+id = \$1\s+AND\s+user_id = \$2/);
    });
  });

  describe("list", () => {
    it("returns the newest live notifications, with their derived category", async () => {
      notifications.find.mockResolvedValue([
        row({ type: NotificationType.BILL_DUE }),
      ]);

      const result = await service.list("user-1");

      expect(notifications.find).toHaveBeenCalledWith({
        where: { userId: "user-1", dismissedAt: IsNull() },
        order: { createdAt: "DESC" },
        take: LIST_PAGE_SIZE,
      });
      // Derived, never stored: a reader gets the category without the table
      // holding a second answer to what the type already says.
      expect(result[0].category).toBe(NotificationCategory.PAYMENTS);
    });

    it("narrows to unread when asked", async () => {
      notifications.find.mockResolvedValue([row()]);

      await service.list("user-1", { unreadOnly: true });

      expect(notifications.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isRead: false, dismissedAt: IsNull() },
        order: { createdAt: "DESC" },
        take: LIST_PAGE_SIZE,
      });
    });

    it("returns nothing rather than failing when there is nothing", async () => {
      notifications.find.mockResolvedValue([]);

      await expect(service.list("user-1")).resolves.toEqual([]);
    });
  });

  describe("markRead", () => {
    it("marks the row read and reports it back", async () => {
      notifications.findOne.mockResolvedValue(row());

      const result = await service.markRead("user-1", "n-1");

      expect(result.isRead).toBe(true);
      expect(result.category).toBe(NotificationCategory.BUDGETS);
    });

    it("reads and writes inside one transaction", async () => {
      notifications.findOne.mockResolvedValue(row());

      await service.markRead("user-1", "n-1");

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["no such notification", null],
      ["one belonging to somebody else", null],
    ])("404s on %s", async (_case, found) => {
      notifications.findOne.mockResolvedValue(found);

      await expect(service.markRead("user-1", "n-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("scopes the lookup to the caller and to live rows", async () => {
      notifications.findOne.mockResolvedValue(row());

      await service.markRead("user-1", "n-1");

      expect(notifications.findOne).toHaveBeenCalledWith({
        where: { id: "n-1", userId: "user-1", dismissedAt: IsNull() },
      });
    });
  });

  describe("dismiss", () => {
    it("soft-dismisses rather than deleting", async () => {
      notifications.findOne.mockResolvedValue(row());

      await service.dismiss("user-1", "n-1");

      expect(notifications.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "n-1", dismissedAt: expect.any(Date) }),
      );
      expect(notifications.delete).not.toHaveBeenCalled();
    });

    it("404s on a row that is not the caller's live row", async () => {
      notifications.findOne.mockResolvedValue(null);

      await expect(service.dismiss("user-1", "n-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("markAllRead", () => {
    it("reports how many rows moved", async () => {
      notifications.update.mockResolvedValue({ affected: 5 });

      await expect(service.markAllRead("user-1")).resolves.toEqual({
        updated: 5,
      });
      expect(notifications.update).toHaveBeenCalledWith(
        { userId: "user-1", isRead: false, dismissedAt: IsNull() },
        { isRead: true },
      );
    });

    it("reports zero rather than nothing when there was nothing to read", async () => {
      notifications.update.mockResolvedValue({ affected: 0 });

      await expect(service.markAllRead("user-1")).resolves.toEqual({
        updated: 0,
      });
    });
  });

  describe("dismissAll", () => {
    it("dismisses every live row when no filter is given", async () => {
      notifications.update.mockResolvedValue({ affected: 7 });

      await expect(service.dismissAll("user-1")).resolves.toEqual({
        dismissed: 7,
      });
      expect(notifications.update).toHaveBeenCalledWith(
        { userId: "user-1", dismissedAt: IsNull() },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("restricts the write to the requested severity", async () => {
      notifications.update.mockResolvedValue({ affected: 2 });

      await service.dismissAll("user-1", {
        severity: NotificationSeverity.CRITICAL,
      });

      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          severity: NotificationSeverity.CRITICAL,
        },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("restricts category=system to the system types", async () => {
      notifications.update.mockResolvedValue({ affected: 1 });

      await service.dismissAll("user-1", { category: "system" });

      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          type: In([...SYSTEM_NOTIFICATION_TYPES]),
        },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("restricts category=financial to everything outside that set", async () => {
      notifications.update.mockResolvedValue({ affected: 3 });

      await service.dismissAll("user-1", { category: "financial" });

      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          type: Not(In([...SYSTEM_NOTIFICATION_TYPES])),
        },
        { dismissedAt: expect.any(Date) },
      );
    });

    it("applies severity and category together", async () => {
      notifications.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.dismissAll("user-1", {
          severity: NotificationSeverity.WARNING,
          category: "financial",
        }),
      ).resolves.toEqual({ dismissed: 0 });
      expect(notifications.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          dismissedAt: IsNull(),
          severity: NotificationSeverity.WARNING,
          type: Not(In([...SYSTEM_NOTIFICATION_TYPES])),
        },
        { dismissedAt: expect.any(Date) },
      );
    });
  });

  describe("purgeOld", () => {
    it("drops dismissed rows past the retention window", async () => {
      notifications.delete.mockResolvedValue({ affected: 5 });

      await service.purgeOld();

      expect(notifications.delete).toHaveBeenCalledWith(
        expect.objectContaining({ dismissedAt: expect.anything() }),
      );
    });

    it("drops read rows the reader left alone, and only those", async () => {
      notifications.delete
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 3 });

      await service.purgeOld();

      expect(notifications.delete).toHaveBeenCalledTimes(2);
      // An unread row is the only record the user has that something happened,
      // so it is never purged however old it is.
      expect(notifications.delete).toHaveBeenLastCalledWith(
        expect.objectContaining({ isRead: true, dismissedAt: IsNull() }),
      );
    });

    it("keeps the cutoff at the documented retention window", async () => {
      const before = Date.now();
      notifications.delete.mockResolvedValue({ affected: 0 });

      await service.purgeOld();

      const where = notifications.delete.mock.calls[0][0] as {
        dismissedAt: { value: Date };
      };
      const cutoff = where.dismissedAt.value.getTime();
      const expected = before - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expected)).toBeLessThan(60_000);
    });

    it("swallows a failure rather than ending the nightly run", async () => {
      notifications.delete.mockRejectedValue(new Error("DB error"));
      jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);

      await expect(service.purgeOld()).resolves.not.toThrow();
    });
  });
});
