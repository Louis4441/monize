import {
  NotificationPreferenceService,
  NOTIFICATION_PREFERENCE_CATEGORIES,
  THROTTLE_MAX_MINUTES,
} from "./notification-preference.service";
import { NotificationCategory } from "./entities/notification.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import * as scopedDb from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db");

describe("NotificationPreferenceService", () => {
  let service: NotificationPreferenceService;
  let userPrefRepo: Record<string, jest.Mock>;
  let notifPrefRepo: Record<string, jest.Mock>;
  let query: jest.Mock;

  beforeEach(() => {
    userPrefRepo = { findOne: jest.fn().mockResolvedValue(null) };
    notifPrefRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    query = jest.fn().mockResolvedValue([]);
    const manager = {
      query,
      getRepository: (entity: unknown) =>
        entity === UserPreference ? userPrefRepo : notifPrefRepo,
    };
    (scopedDb.withScopedDb as jest.Mock).mockImplementation(
      (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
    );
    service = new NotificationPreferenceService(
      {} as ConstructorParameters<typeof NotificationPreferenceService>[0],
    );
  });

  describe("resolveEmail", () => {
    it("defaults email on when there is no row and no master preference", async () => {
      expect(
        await service.resolveEmail("u1", NotificationCategory.PAYMENTS),
      ).toBe(true);
    });

    it("returns false when the master switch is off, whatever the category row says", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      notifPrefRepo.findOne.mockResolvedValue({ email: true });
      expect(
        await service.resolveEmail("u1", NotificationCategory.PAYMENTS),
      ).toBe(false);
      // The master kill short-circuits: the per-category row is never consulted.
      expect(notifPrefRepo.findOne).not.toHaveBeenCalled();
    });

    it("honours an explicit per-category off while the master is on", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: true });
      notifPrefRepo.findOne.mockResolvedValue({ email: false });
      expect(
        await service.resolveEmail("u1", NotificationCategory.BUDGETS),
      ).toBe(false);
    });

    it("honours an explicit per-category on", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: true });
      notifPrefRepo.findOne.mockResolvedValue({ email: true });
      expect(
        await service.resolveEmail("u1", NotificationCategory.BUDGETS),
      ).toBe(true);
    });

    it("treats a NULL master switch as off, like the producers it replaced", async () => {
      // notification_email is a nullable column. The old guard was
      // `!prefs.notificationEmail`, so NULL blocked; `=== false` would have let
      // it through. Keep the conservative reading and never consult the row.
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: null });
      notifPrefRepo.findOne.mockResolvedValue({ email: true });
      expect(
        await service.resolveEmail("u1", NotificationCategory.PAYMENTS),
      ).toBe(false);
      expect(notifPrefRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe("resolveThrottleMinutes", () => {
    it("defaults to 0 (no throttle) when there is no row", async () => {
      expect(
        await service.resolveThrottleMinutes(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toBe(0);
    });

    it("returns the stored window", async () => {
      notifPrefRepo.findOne.mockResolvedValue({ throttleMinutes: 15 });
      expect(
        await service.resolveThrottleMinutes(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toBe(15);
    });

    it("clamps a stored window above the cap", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        throttleMinutes: THROTTLE_MAX_MINUTES + 500,
      });
      expect(
        await service.resolveThrottleMinutes(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toBe(THROTTLE_MAX_MINUTES);
    });

    it("floors a negative stored window at 0", async () => {
      notifPrefRepo.findOne.mockResolvedValue({ throttleMinutes: -5 });
      expect(
        await service.resolveThrottleMinutes(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toBe(0);
    });
  });

  describe("list", () => {
    it("returns one entry per matrix category, email on and throttle 0", async () => {
      expect(await service.list("u1")).toEqual(
        NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => ({
          category,
          email: true,
          throttleMinutes: 0,
        })),
      );
    });

    it("reflects stored per-category state and is not master-gated", async () => {
      // Master off must NOT bleed into the displayed per-category state.
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      notifPrefRepo.find.mockResolvedValue([
        {
          category: NotificationCategory.PAYMENTS,
          email: false,
          throttleMinutes: 30,
        },
      ]);
      const res = await service.list("u1");
      const payments = res.find(
        (r) => r.category === NotificationCategory.PAYMENTS,
      );
      expect(payments).toEqual({
        category: NotificationCategory.PAYMENTS,
        email: false,
        throttleMinutes: 30,
      });
      expect(
        res.find((r) => r.category === NotificationCategory.BUDGETS),
      ).toEqual({
        category: NotificationCategory.BUDGETS,
        email: true,
        throttleMinutes: 0,
      });
    });
  });

  describe("updatePreference", () => {
    it("upserts with COALESCE so an omitted field keeps its stored value", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: false,
        throttleMinutes: 0,
      });
      const result = await service.updatePreference(
        "u1",
        NotificationCategory.PAYMENTS,
        { email: false },
      );
      const [sql, params] = query.mock.calls[0];
      // A single insert-with-conflict, not read-then-insert.
      expect(String(sql)).toContain(
        "ON CONFLICT (user_id, category) DO UPDATE",
      );
      // email present -> its param; throttle omitted -> NULL, so COALESCE keeps
      // the stored throttle_minutes.
      expect(params).toEqual([
        "u1",
        NotificationCategory.PAYMENTS,
        false,
        null,
      ]);
      expect(result).toEqual({
        category: NotificationCategory.PAYMENTS,
        email: false,
        throttleMinutes: 0,
      });
    });

    it("clamps a throttle window above the cap before writing", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        throttleMinutes: THROTTLE_MAX_MINUTES,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        throttleMinutes: THROTTLE_MAX_MINUTES + 999,
      });
      const params = query.mock.calls[0][1];
      // email omitted -> NULL; throttle clamped to the cap.
      expect(params).toEqual([
        "u1",
        NotificationCategory.BUDGETS,
        null,
        THROTTLE_MAX_MINUTES,
      ]);
    });

    it("writes 0 for a throttle window of 0 (disable), not NULL", async () => {
      // 0 is an explicit choice ("no throttle"), distinct from "field omitted".
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        throttleMinutes: 0,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        throttleMinutes: 0,
      });
      const params = query.mock.calls[0][1];
      expect(params).toEqual(["u1", NotificationCategory.BUDGETS, null, 0]);
    });
  });
});
