import {
  NotificationPreferenceService,
  NOTIFICATION_PREFERENCE_CATEGORIES,
} from "./notification-preference.service";
import { NotificationCategory } from "./entities/notification.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import * as scopedDb from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db");

describe("NotificationPreferenceService", () => {
  let service: NotificationPreferenceService;
  let userPrefRepo: Record<string, jest.Mock>;
  let notifPrefRepo: Record<string, jest.Mock>;
  let insertBuilder: {
    insert: jest.Mock;
    values: jest.Mock;
    orUpdate: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(() => {
    userPrefRepo = { findOne: jest.fn().mockResolvedValue(null) };
    // The upsert chain setEmail uses: insert().values().orUpdate().execute().
    insertBuilder = {
      insert: jest.fn(() => insertBuilder),
      values: jest.fn(() => insertBuilder),
      orUpdate: jest.fn(() => insertBuilder),
      execute: jest.fn().mockResolvedValue({}),
    };
    notifPrefRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => insertBuilder),
    };
    const manager = {
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

  describe("list", () => {
    it("returns one entry per matrix category, defaulting on", async () => {
      expect(await service.list("u1")).toEqual(
        NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => ({
          category,
          email: true,
        })),
      );
    });

    it("reflects a stored per-category off and is not master-gated", async () => {
      // Master off must NOT bleed into the displayed per-category state.
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      notifPrefRepo.find.mockResolvedValue([
        { category: NotificationCategory.PAYMENTS, email: false },
      ]);
      const res = await service.list("u1");
      expect(
        res.find((r) => r.category === NotificationCategory.PAYMENTS)?.email,
      ).toBe(false);
      expect(
        res.find((r) => r.category === NotificationCategory.BUDGETS)?.email,
      ).toBe(true);
    });
  });

  describe("setEmail", () => {
    it("upserts the (user, category) row atomically", async () => {
      const result = await service.setEmail(
        "u1",
        NotificationCategory.PAYMENTS,
        false,
      );
      // A single insert-with-conflict, not read-then-insert, so two concurrent
      // first writes cannot both INSERT and collide on the primary key.
      expect(insertBuilder.values).toHaveBeenCalledWith({
        userId: "u1",
        category: NotificationCategory.PAYMENTS,
        email: false,
      });
      expect(insertBuilder.orUpdate).toHaveBeenCalledWith(
        ["email"],
        ["user_id", "category"],
      );
      expect(insertBuilder.execute).toHaveBeenCalled();
      expect(result).toEqual({
        category: NotificationCategory.PAYMENTS,
        email: false,
      });
    });
  });
});
