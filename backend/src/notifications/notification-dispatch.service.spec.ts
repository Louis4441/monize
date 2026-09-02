import { NotificationDispatchService } from "./notification-dispatch.service";
import {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { User } from "../users/entities/user.entity";
import * as scopedDb from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db");

describe("NotificationDispatchService", () => {
  let service: NotificationDispatchService;
  let create: jest.Mock;
  let resolveDelivery: jest.Mock;
  let sendToUser: jest.Mock;
  let sendMail: jest.Mock;
  let getStatus: jest.Mock;
  let query: jest.Mock;
  let userRepo: Record<string, jest.Mock>;
  let prefRepo: Record<string, jest.Mock>;

  const row = (over: Partial<Notification> = {}): Notification =>
    ({
      id: "n1",
      userId: "u1",
      type: NotificationType.OVER_BUDGET, // -> BUDGETS
      severity: NotificationSeverity.WARNING,
      title: "Groceries over budget",
      message: "You have spent 105% of Groceries.",
      target: "/budgets/b1",
      data: {},
      dedupeKey: null,
      createdAt: new Date("2026-09-02T10:00:00Z"),
      ...over,
    }) as Notification;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue(row());
    resolveDelivery = jest.fn().mockResolvedValue({
      emailNotification: false,
      push: false,
      throttleMinutes: 0,
    });
    sendToUser = jest.fn().mockResolvedValue({ attempted: 1, delivered: 1 });
    sendMail = jest.fn().mockResolvedValue(undefined);
    getStatus = jest.fn().mockReturnValue({ configured: true });
    query = jest.fn().mockResolvedValue([{ suppress: false }]);
    userRepo = {
      findOne: jest.fn().mockResolvedValue({ email: "u1@example.com" }),
    };
    prefRepo = { findOne: jest.fn().mockResolvedValue({ language: "en" }) };

    const manager = {
      query,
      getRepository: (entity: unknown) =>
        entity === User ? userRepo : (prefRepo as unknown),
    };
    (scopedDb.withScopedDb as jest.Mock).mockImplementation(
      (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
    );

    service = new NotificationDispatchService(
      {} as never,
      { create } as never,
      { resolveNotificationDelivery: resolveDelivery } as never,
      { sendToUser } as never,
      { getStatus, sendMail } as never,
      { get: (_k: string, d: string) => d } as never,
      {
        translate: (_k: string, o?: { defaultValue?: string }) =>
          o?.defaultValue,
      } as never,
    );
  });

  it("writes through the one write door and returns the row (INV-DISPATCH-001)", async () => {
    const result = await service.notify("u1", {
      type: NotificationType.OVER_BUDGET,
    } as never);
    expect(create).toHaveBeenCalledWith("u1", {
      type: NotificationType.OVER_BUDGET,
    });
    expect(result?.id).toBe("n1");
  });

  it("does not fan out when create lost the conflict race (null)", async () => {
    create.mockResolvedValue(null);
    expect(await service.notify("u1", {} as never)).toBeNull();
    expect(sendToUser).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("always writes the in-app row even with push and email both off (INV-DISPATCH-002)", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(create).toHaveBeenCalled();
    expect(sendToUser).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("pushes a privacy-minimal payload when push is on", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(sendToUser).toHaveBeenCalledTimes(1);
    const [userId, payload] = sendToUser.mock.calls[0];
    expect(userId).toBe("u1");
    expect(payload).toEqual({
      type: NotificationType.OVER_BUDGET,
      title: "Groceries over budget",
      body: "You have spent 105% of Groceries.",
      target: "/budgets/b1",
      // no dedupeKey -> the row id, never a name/amount.
      collapseKey: "n1",
    });
  });

  it("resolves delivery against the row's own category (SCHEDULED_POST_FAILED is PAYMENTS)", async () => {
    // A scheduled-post failure is about a scheduled payment, so it shares the
    // PAYMENTS row -- the matrix decision must be read for PAYMENTS, not SYSTEM.
    create.mockResolvedValue(
      row({
        type: NotificationType.SCHEDULED_POST_FAILED,
        dedupeKey: "SCHEDULED_POST_FAILED:st-1:2026-09-02",
      }),
    );
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(resolveDelivery).toHaveBeenCalledWith(
      "u1",
      NotificationCategory.PAYMENTS,
    );
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });

  it("uses the dedupe key as the collapse key when present", async () => {
    create.mockResolvedValue(row({ dedupeKey: "PROVIDER_OUTAGE:yahoo" }));
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(sendToUser.mock.calls[0][1].collapseKey).toBe(
      "PROVIDER_OUTAGE:yahoo",
    );
  });

  it("sends an immediate email in the recipient's locale when email is on", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: true,
      push: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [to, , html] = sendMail.mock.calls[0];
    expect(to).toBe("u1@example.com");
    expect(html).toContain("Groceries over budget");
  });

  it("skips email when SMTP is not configured, without throwing", async () => {
    getStatus.mockReturnValue({ configured: false });
    resolveDelivery.mockResolvedValue({
      emailNotification: true,
      push: false,
      throttleMinutes: 0,
    });
    await expect(service.notify("u1", {} as never)).resolves.toBeTruthy();
    expect(sendMail).not.toHaveBeenCalled();
  });

  describe("throttle (INV-DISPATCH-003)", () => {
    it("suppresses the fan-out when the window says so", async () => {
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 15,
      });
      query.mockResolvedValue([{ suppress: true }]);
      await service.notify("u1", {} as never);
      expect(sendToUser).not.toHaveBeenCalled();
    });

    it("does not throttle when the window is 0 (no throttle read)", async () => {
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 0,
      });
      await service.notify("u1", {} as never);
      expect(query).not.toHaveBeenCalled();
      expect(sendToUser).toHaveBeenCalled();
    });

    it("takes the advisory lock on every throttled path, push included (D7)", async () => {
      // email path -> lock taken
      resolveDelivery.mockResolvedValue({
        emailNotification: true,
        push: false,
        throttleMinutes: 15,
      });
      await service.notify("u1", {} as never);
      expect(
        query.mock.calls.filter((c) =>
          String(c[0]).includes("pg_advisory_xact_lock"),
        ),
      ).toHaveLength(1);

      // push-only path -> lock ALSO taken: two replicas each winning a distinct
      // same-category row would not collapse device-side (distinct collapse
      // keys), so the decider is serialised here too.
      query.mockClear();
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 15,
      });
      await service.notify("u1", {} as never);
      expect(
        query.mock.calls.filter((c) =>
          String(c[0]).includes("pg_advisory_xact_lock"),
        ),
      ).toHaveLength(1);
    });

    it("passes the escalation set: only priors at or above this severity suppress", async () => {
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 30,
      });
      create.mockResolvedValue(
        row({ severity: NotificationSeverity.CRITICAL }),
      );
      await service.notify("u1", {} as never);
      const existsCall = query.mock.calls.find((c) =>
        String(c[0]).includes("SELECT EXISTS"),
      );
      // A CRITICAL notification's "at or above" set is just [critical] -- a prior
      // WARNING must NOT suppress it (escalation always goes).
      expect(existsCall?.[1]?.[4]).toEqual(["critical"]);
    });
  });

  it("never lets a fan-out failure escape notify (INV-DISPATCH-004)", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      throttleMinutes: 0,
    });
    sendToUser.mockRejectedValue(new Error("push exploded"));
    const spy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);
    await expect(service.notify("u1", {} as never)).resolves.toBeTruthy();
    expect(spy).toHaveBeenCalled();
  });
});
