import { BadRequestException, NotFoundException } from "@nestjs/common";

import {
  NotificationReminderService,
  DEDUPE_BASE_MAX_LENGTH,
} from "./notification-reminder.service";
import { NotificationService } from "./notification.service";
import { Notification } from "./entities/notification.entity";
import { ReminderRepeatMode } from "./entities/notification-reminder.entity";
import {
  MAX_ACTIVE_REMINDERS_PER_USER,
  REMINDER_MIN_INTERVAL_MINUTES,
} from "./notification-reminder.constants";
import * as scopedDb from "../common/db/scoped-db";
import * as withContext from "../common/db/with-context";

jest.mock("../common/db/scoped-db");
jest.mock("../common/db/with-context");

describe("NotificationReminderService", () => {
  let service: NotificationReminderService;
  let notifications: jest.Mocked<Pick<NotificationService, "create">>;
  let sourceRepo: Record<string, jest.Mock>;
  let reminderRepo: Record<string, jest.Mock>;
  let query: jest.Mock;

  beforeEach(() => {
    sourceRepo = { findOne: jest.fn().mockResolvedValue(null) };
    reminderRepo = {
      find: jest.fn().mockResolvedValue([]),
      // Default: no existing active reminder for the source, and well under cap.
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn(async (v) => ({
        id: "rem-1",
        createdAt: new Date("2026-09-02T00:00:00Z"),
        lastFiredAt: null,
        fireCount: 0,
        ...v,
      })),
    };
    query = jest.fn().mockResolvedValue([]);
    const manager = {
      query,
      getRepository: (entity: unknown) =>
        entity === Notification ? sourceRepo : reminderRepo,
    };
    (scopedDb.withScopedDb as jest.Mock).mockImplementation(
      (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
    );
    (withContext.withSystemContext as jest.Mock).mockImplementation(
      (fn: () => unknown) => fn(),
    );
    (withContext.withUserContext as jest.Mock).mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );

    notifications = { create: jest.fn().mockResolvedValue({ id: "n-fresh" }) };
    service = new NotificationReminderService(
      {} as ConstructorParameters<typeof NotificationReminderService>[0],
      notifications as unknown as NotificationService,
    );
  });

  const source = {
    id: "src-1",
    userId: "u1",
    type: "BILL_DUE",
    severity: "warning",
    title: "Rent due",
    message: "Rent is due in 3 days",
    data: { budget: "x" },
    target: "/bills",
    dedupeKey: null,
  };

  describe("create", () => {
    it("copies the source's content into the template and schedules one interval out", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      const now = 1_000_000_000_000;
      jest.spyOn(Date, "now").mockReturnValue(now);

      const view = await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 15,
      });

      // Loaded the caller's own LIVE source (dismissed rows are not eligible).
      expect(sourceRepo.findOne).toHaveBeenCalledWith({
        where: {
          id: "src-1",
          userId: "u1",
          dismissedAt: expect.anything(),
        },
      });
      const saved = reminderRepo.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        userId: "u1",
        sourceNotificationId: "src-1",
        type: "BILL_DUE",
        severity: "warning",
        title: "Rent due",
        message: "Rent is due in 3 days",
        target: "/bills",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 15,
      });
      // First nag one interval after creation (source already delivered #1).
      expect((saved.nextFireAt as Date).getTime()).toBe(now + 15 * 60_000);
      expect(view.intervalMinutes).toBe(15);
    });

    it("derives dedupe_base from the source dedupe key when it has one", async () => {
      sourceRepo.findOne.mockResolvedValue({
        ...source,
        dedupeKey: "PROVIDER_OUTAGE:yahoo",
      });
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.ONCE,
        intervalMinutes: 30,
      });
      expect(reminderRepo.save.mock.calls[0][0].dedupeBase).toBe(
        "PROVIDER_OUTAGE:yahoo",
      );
    });

    it("bounds dedupe_base to the column width", async () => {
      sourceRepo.findOne.mockResolvedValue({
        ...source,
        dedupeKey: "x".repeat(200),
      });
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.ONCE,
        intervalMinutes: 30,
      });
      expect(
        reminderRepo.save.mock.calls[0][0].dedupeBase.length,
      ).toBeLessThanOrEqual(DEDUPE_BASE_MAX_LENGTH);
    });

    it("clamps an interval below the floor UP, never below it", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 2,
      });
      expect(reminderRepo.save.mock.calls[0][0].intervalMinutes).toBe(
        REMINDER_MIN_INTERVAL_MINUTES,
      );
    });

    it("refuses a source that is not the caller's live notification", async () => {
      sourceRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create("u1", {
          sourceNotificationId: "missing",
          repeatMode: ReminderRepeatMode.ONCE,
          intervalMinutes: 15,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reminderRepo.save).not.toHaveBeenCalled();
    });

    it("re-configures the one active reminder instead of adding a parallel nag, bypassing the cap", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      // An active reminder already exists for this source.
      reminderRepo.findOne.mockResolvedValue({
        id: "existing",
        userId: "u1",
        sourceNotificationId: "src-1",
        fireCount: 7,
        stoppedAt: null,
      });
      await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.ONCE,
        intervalMinutes: 30,
      });
      const saved = reminderRepo.save.mock.calls[0][0];
      // The same row is updated (not a new one), its schedule and fire count reset.
      expect(saved.id).toBe("existing");
      expect(saved.repeatMode).toBe(ReminderRepeatMode.ONCE);
      expect(saved.intervalMinutes).toBe(30);
      expect(saved.fireCount).toBe(0);
      expect(saved.stoppedAt).toBeNull();
      // A re-configure is not a new reminder, so the cap is not consulted.
      expect(reminderRepo.count).not.toHaveBeenCalled();
    });

    it("refuses a genuinely new reminder past the per-user cap", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      reminderRepo.findOne.mockResolvedValue(null); // no existing for this source
      reminderRepo.count.mockResolvedValue(MAX_ACTIVE_REMINDERS_PER_USER);
      await expect(
        service.create("u1", {
          sourceNotificationId: "src-1",
          repeatMode: ReminderRepeatMode.REPEAT,
          intervalMinutes: 15,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reminderRepo.save).not.toHaveBeenCalled();
    });

    it("recovers from a concurrent unique-index conflict by re-reading the winner", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      // First pass: no existing -> insert -> loses the race (23505 on the index).
      // Second pass: the winner's row is now visible -> update it.
      reminderRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "winner",
        userId: "u1",
        sourceNotificationId: "src-1",
        stoppedAt: null,
      });
      reminderRepo.save
        .mockRejectedValueOnce({
          code: "23505",
          constraint: "idx_notification_reminders_active_source",
        })
        .mockResolvedValueOnce({
          id: "winner",
          createdAt: new Date("2026-09-02T00:00:00Z"),
          nextFireAt: new Date("2026-09-02T00:15:00Z"),
          lastFiredAt: null,
          fireCount: 0,
          sourceNotificationId: "src-1",
          type: "BILL_DUE",
          severity: "warning",
          title: "Rent due",
          message: "Rent is due in 3 days",
          target: "/bills",
          repeatMode: ReminderRepeatMode.REPEAT,
          intervalMinutes: 15,
        });
      const view = await service.create("u1", {
        sourceNotificationId: "src-1",
        repeatMode: ReminderRepeatMode.REPEAT,
        intervalMinutes: 15,
      });
      expect(view.id).toBe("winner");
      expect(reminderRepo.save).toHaveBeenCalledTimes(2);
    });

    it("does not swallow a non-conflict save error", async () => {
      sourceRepo.findOne.mockResolvedValue(source);
      reminderRepo.save.mockRejectedValue(new Error("disk full"));
      await expect(
        service.create("u1", {
          sourceNotificationId: "src-1",
          repeatMode: ReminderRepeatMode.REPEAT,
          intervalMinutes: 15,
        }),
      ).rejects.toThrow("disk full");
    });
  });

  describe("stop", () => {
    it("reports stopped when a live row was the caller's", async () => {
      query.mockResolvedValue([[{ id: "rem-1" }], 1]);
      expect(await service.stop("u1", "rem-1")).toEqual({ stopped: true });
      const [sql, params] = query.mock.calls[0];
      expect(String(sql)).toContain("stopped_at IS NULL");
      expect(params).toEqual(["rem-1", "u1"]);
    });

    it("is idempotent: an already-stopped or foreign id returns stopped:false, never throws", async () => {
      query.mockResolvedValue([[], 0]);
      expect(await service.stop("u1", "rem-1")).toEqual({ stopped: false });
    });
  });

  describe("stopRemindersFor", () => {
    it("stops every live reminder pointing at a dismissed source, scoped to the owner", async () => {
      query.mockResolvedValue([[{ id: "a" }, { id: "b" }], 2]);
      expect(await service.stopRemindersFor("u1", "src-1")).toEqual({
        stopped: 2,
      });
      const [, params] = query.mock.calls[0];
      expect(params).toEqual(["u1", "src-1"]);
    });
  });

  describe("fireDue", () => {
    function claim(overrides: Record<string, unknown> = {}) {
      return {
        id: "rem-1",
        user_id: "u1",
        alert_type: "BILL_DUE",
        severity: "warning",
        title: "Rent due",
        message: "Rent is due",
        data: { budget: "x" },
        target: "/bills",
        dedupe_base: "BILL_DUE",
        repeat_mode: "repeat",
        fire_count: 3,
        ...overrides,
      };
    }

    it("does nothing when no reminder is due", async () => {
      // sweep -> [[],0]; claim -> [[],0]
      query.mockResolvedValue([[], 0]);
      await service.fireDue();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it("re-emits each claimed row as a fresh row with a per-fire dedupe key and the reminder id", async () => {
      query
        .mockResolvedValueOnce([[], 0]) // sweep
        .mockResolvedValueOnce([[claim()], 1]); // claim
      await service.fireDue();

      expect(notifications.create).toHaveBeenCalledTimes(1);
      const [userId, input] = notifications.create.mock.calls[0];
      expect(userId).toBe("u1");
      expect(input.type).toBe("BILL_DUE");
      // fresh row: the fire ordinal makes the dedupe key unique per fire.
      expect(input.dedupeKey).toBe("BILL_DUE:rem:rem-1:3");
      // the reminder id travels on the row for the Stop control / push action.
      expect(input.data).toMatchObject({ budget: "x", reminderId: "rem-1" });
      // no budget linkage on a re-emit -> the dedupe_key index, not the
      // fingerprint index.
      expect(input.budgetId).toBeUndefined();
    });

    it("does NOT consume a one-shot in the claim (a failed delivery must be able to retry)", async () => {
      query.mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([[], 0]);
      await service.fireDue();
      // The claim UPDATE is the second query. It advances next_fire_at and
      // fire_count but never sets stopped_at -- the one-shot is stopped only
      // after its delivery is written (reEmit), so a failed delivery retries.
      const claimSql = String(query.mock.calls[1][0]);
      expect(claimSql).toContain("next_fire_at = CURRENT_TIMESTAMP");
      // The claim WHERE still guards on stopped_at, but it never SETS it, and
      // no longer branches on repeat_mode = $1 (the removed ONCE consumption).
      expect(claimSql).toContain("stopped_at IS NULL");
      expect(claimSql).not.toContain("stopped_at = CURRENT_TIMESTAMP");
      expect(claimSql).not.toContain("repeat_mode = $1");
      expect(claimSql).toContain("repeat_mode"); // returned, for reEmit's decision
    });

    it("stops a one-shot in the SAME transaction as its delivery, not before", async () => {
      query
        .mockResolvedValueOnce([[], 0]) // sweep
        .mockResolvedValueOnce([[claim({ repeat_mode: "once" })], 1]) // claim
        .mockResolvedValueOnce([[{ id: "rem-1" }], 1]); // reEmit's stop UPDATE
      await service.fireDue();

      // The delivery was written...
      expect(notifications.create).toHaveBeenCalledTimes(1);
      // ...and the stop ran, ownership-scoped and guarded on stopped_at IS NULL,
      // as the third query (after sweep + claim), i.e. inside reEmit.
      const stopCall = query.mock.calls[2];
      expect(String(stopCall[0])).toContain("stopped_at = CURRENT_TIMESTAMP");
      expect(String(stopCall[0])).toContain("stopped_at IS NULL");
      expect(stopCall[1]).toEqual(["rem-1", "u1"]);
    });

    it("does not stop a repeating reminder after firing", async () => {
      query
        .mockResolvedValueOnce([[], 0]) // sweep
        .mockResolvedValueOnce([[claim({ repeat_mode: "repeat" })], 1]); // claim
      await service.fireDue();
      expect(notifications.create).toHaveBeenCalledTimes(1);
      // Only sweep + claim ran; no stop UPDATE for a repeat.
      expect(query).toHaveBeenCalledTimes(2);
    });

    it("isolates a failing re-emit: one user's failure does not skip the rest", async () => {
      notifications.create
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(null);
      query
        .mockResolvedValueOnce([[], 0])
        .mockResolvedValueOnce([
          [
            claim({ id: "r1", user_id: "uA" }),
            claim({ id: "r2", user_id: "uB" }),
          ],
          2,
        ]);
      await expect(service.fireDue()).resolves.toBeUndefined();
      expect(notifications.create).toHaveBeenCalledTimes(2);
    });

    it("never throws out of the cron even if the claim query fails", async () => {
      query.mockRejectedValue(new Error("db down"));
      await expect(service.fireDue()).resolves.toBeUndefined();
    });
  });
});
