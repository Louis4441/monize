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

  describe("resolveEmail (report-mode email gate)", () => {
    it("defaults on when there is no row and no master preference", async () => {
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

    it("treats a NULL master switch as off, like the producers it replaced", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: null });
      notifPrefRepo.findOne.mockResolvedValue({ email: true });
      expect(
        await service.resolveEmail("u1", NotificationCategory.PAYMENTS),
      ).toBe(false);
      expect(notifPrefRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns the default shape per category: report email on, notification off, push off, throttle 0", async () => {
      expect(await service.list("u1")).toEqual(
        NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => ({
          category,
          email: true,
          emailNotification: false,
          push: false,
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
          emailNotification: true,
          push: true,
          throttleMinutes: 30,
        },
      ]);
      const res = await service.list("u1");
      expect(
        res.find((r) => r.category === NotificationCategory.PAYMENTS),
      ).toEqual({
        category: NotificationCategory.PAYMENTS,
        email: false,
        emailNotification: true,
        push: true,
        throttleMinutes: 30,
      });
      expect(
        res.find((r) => r.category === NotificationCategory.BUDGETS),
      ).toEqual({
        category: NotificationCategory.BUDGETS,
        email: true,
        emailNotification: false,
        push: false,
        throttleMinutes: 0,
      });
    });

    it("clamps a stored throttle window above the cap", async () => {
      notifPrefRepo.find.mockResolvedValue([
        {
          category: NotificationCategory.BUDGETS,
          email: true,
          emailNotification: false,
          throttleMinutes: THROTTLE_MAX_MINUTES + 500,
        },
      ]);
      const budgets = (await service.list("u1")).find(
        (r) => r.category === NotificationCategory.BUDGETS,
      );
      expect(budgets?.throttleMinutes).toBe(THROTTLE_MAX_MINUTES);
    });
  });

  describe("updatePreference", () => {
    it("upserts with COALESCE so an omitted field keeps its stored value", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: false,
        emailNotification: false,
        push: false,
        throttleMinutes: 0,
      });
      const result = await service.updatePreference(
        "u1",
        NotificationCategory.PAYMENTS,
        { email: false },
      );
      const [sql, params] = query.mock.calls[0];
      expect(String(sql)).toContain(
        "ON CONFLICT (user_id, category) DO UPDATE",
      );
      // Only email present -> its param; the others omitted pass NULL, so
      // COALESCE keeps their stored values. Order: email, emailNotification,
      // throttle, push.
      expect(params).toEqual([
        "u1",
        NotificationCategory.PAYMENTS,
        false,
        null,
        null,
        null,
      ]);
      expect(result).toEqual({
        category: NotificationCategory.PAYMENTS,
        email: false,
        emailNotification: false,
        push: false,
        throttleMinutes: 0,
      });
    });

    it("writes each field independently (notification email and throttle)", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: true,
        push: false,
        throttleMinutes: 15,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        emailNotification: true,
        throttleMinutes: 15,
      });
      const params = query.mock.calls[0][1];
      // email and push omitted -> NULL; notification email and throttle set.
      expect(params).toEqual([
        "u1",
        NotificationCategory.BUDGETS,
        null,
        true,
        15,
        null,
      ]);
    });

    it("writes the push channel independently", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: false,
        push: true,
        throttleMinutes: 0,
      });
      await service.updatePreference("u1", NotificationCategory.PAYMENTS, {
        push: true,
      });
      const params = query.mock.calls[0][1];
      // Only push present -> the sixth param; the rest NULL.
      expect(params).toEqual([
        "u1",
        NotificationCategory.PAYMENTS,
        null,
        null,
        null,
        true,
      ]);
    });

    it("clamps a throttle window above the cap before writing", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: false,
        push: false,
        throttleMinutes: THROTTLE_MAX_MINUTES,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        throttleMinutes: THROTTLE_MAX_MINUTES + 999,
      });
      const params = query.mock.calls[0][1];
      expect(params).toEqual([
        "u1",
        NotificationCategory.BUDGETS,
        null,
        null,
        THROTTLE_MAX_MINUTES,
        null,
      ]);
    });

    it("writes 0 for a throttle window of 0 (disable), not NULL", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: false,
        push: false,
        throttleMinutes: 0,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        throttleMinutes: 0,
      });
      const params = query.mock.calls[0][1];
      expect(params).toEqual([
        "u1",
        NotificationCategory.BUDGETS,
        null,
        null,
        0,
        null,
      ]);
    });
  });

  describe("resolveNotificationDelivery (the dispatch's one read)", () => {
    it("defaults everything off: no email, no push, no throttle", async () => {
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.PAYMENTS,
        ),
      ).toEqual({ emailNotification: false, push: false, throttleMinutes: 0 });
    });

    it("returns the stored flags and clamped throttle when the master is on", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: true });
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: true,
        push: true,
        throttleMinutes: 15,
      });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toEqual({ emailNotification: true, push: true, throttleMinutes: 15 });
    });

    it("kills the immediate email on the master switch but NOT push", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: true,
        push: true,
        throttleMinutes: 0,
      });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toEqual({ emailNotification: false, push: true, throttleMinutes: 0 });
    });

    it("clamps a stored throttle window above the cap", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: THROTTLE_MAX_MINUTES + 500,
      });
      const res = await service.resolveNotificationDelivery(
        "u1",
        NotificationCategory.BUDGETS,
      );
      expect(res.throttleMinutes).toBe(THROTTLE_MAX_MINUTES);
    });
  });
});
