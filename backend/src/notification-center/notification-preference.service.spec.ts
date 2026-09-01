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

  beforeEach(() => {
    userPrefRepo = { findOne: jest.fn().mockResolvedValue(null) };
    notifPrefRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
      create: jest.fn().mockImplementation((x) => x),
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
    it("updates an existing row", async () => {
      const row = {
        userId: "u1",
        category: NotificationCategory.PAYMENTS,
        email: true,
      };
      notifPrefRepo.findOne.mockResolvedValue(row);
      await service.setEmail("u1", NotificationCategory.PAYMENTS, false);
      expect(row.email).toBe(false);
      expect(notifPrefRepo.save).toHaveBeenCalledWith(row);
    });

    it("creates a row when absent", async () => {
      await service.setEmail("u1", NotificationCategory.BUDGETS, false);
      expect(notifPrefRepo.create).toHaveBeenCalledWith({
        userId: "u1",
        category: NotificationCategory.BUDGETS,
        email: false,
      });
      expect(notifPrefRepo.save).toHaveBeenCalled();
    });
  });
});
