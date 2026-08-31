import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { Test, TestingModule } from "@nestjs/testing";
import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";
import { ROLES_KEY } from "../auth/guards/roles.guard";
import { PushController } from "./push.controller";
import { AdminNotificationsController } from "./admin-notifications.controller";
import { PushConfigService } from "./push-config.service";
import { PushSubscriptionService } from "./push-subscription.service";

const CALLER = { user: { id: "user-1" } };

describe("PushController", () => {
  let controller: PushController;
  let pushConfig: Partial<Record<keyof PushConfigService, jest.Mock>>;
  let subscriptions: Partial<Record<keyof PushSubscriptionService, jest.Mock>>;

  beforeEach(async () => {
    pushConfig = { getPublicConfig: jest.fn() };
    subscriptions = {
      listForUser: jest.fn(),
      subscribe: jest.fn(),
      remove: jest.fn(),
      sendTest: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: PushConfigService, useValue: pushConfig },
        { provide: PushSubscriptionService, useValue: subscriptions },
      ],
    }).compile();

    controller = module.get(PushController);
  });

  // The acceptance criterion this pins (discussion #1291): a subscription
  // belongs to the authenticated caller. Every route below reads req.user.id,
  // and no route takes a user id from anywhere else.
  it.each([
    ["list", () => controller.list(CALLER), "listForUser"],
    ["test", () => controller.test(CALLER), "sendTest"],
  ] as const)(
    "derives the tenant from the JWT on %s",
    (_name, call, method) => {
      call();
      expect(subscriptions[method]).toHaveBeenCalledWith("user-1");
    },
  );

  it("passes the caller, the payload and the browser's user agent to subscribe", () => {
    const dto = { endpoint: "https://x", p256dh: "a", auth: "b" } as never;

    controller.subscribe(CALLER, dto, "Mozilla/5.0");

    expect(subscriptions.subscribe).toHaveBeenCalledWith(
      "user-1",
      dto,
      "Mozilla/5.0",
    );
  });

  it("passes a null user agent rather than undefined when the header is absent", () => {
    const dto = { endpoint: "https://x", p256dh: "a", auth: "b" } as never;

    controller.subscribe(CALLER, dto);

    expect(subscriptions.subscribe).toHaveBeenCalledWith("user-1", dto, null);
  });

  it("scopes a device removal to the caller", () => {
    controller.remove(CALLER, "device-1");

    expect(subscriptions.remove).toHaveBeenCalledWith("user-1", "device-1");
  });

  it("guards every route with the JWT strategy", () => {
    const guards = new Reflector().get("__guards__", PushController) ?? [];
    const names = guards.map((g: unknown) => (g as { name?: string })?.name);

    expect(guards).toHaveLength(1);
    expect(names[0]).toBe(AuthGuard("jwt").name);
  });

  // Every demo visitor shares one account, so a subscription registered by one
  // visitor would receive the test notification another visitor triggered.
  it.each(["subscribe", "test"] as const)(
    "restricts %s in demo mode",
    (method) => {
      expect(
        new Reflector().get(
          DEMO_RESTRICTED_KEY,
          PushController.prototype[method],
        ),
      ).toBe(true);
    },
  );

  it.each(["list", "remove", "getConfig"] as const)(
    "leaves the read-only route %s available in demo mode",
    (method) => {
      expect(
        new Reflector().get(
          DEMO_RESTRICTED_KEY,
          PushController.prototype[method],
        ),
      ).toBeUndefined();
    },
  );
});

describe("AdminNotificationsController", () => {
  let controller: AdminNotificationsController;
  let pushConfig: Partial<Record<keyof PushConfigService, jest.Mock>>;

  beforeEach(async () => {
    pushConfig = {
      getAdminConfig: jest.fn(),
      setWebPushEnabled: jest.fn(),
      rotateKeyPair: jest
        .fn()
        .mockResolvedValue({ config: { enabled: true }, disabled: 3 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminNotificationsController],
      providers: [{ provide: PushConfigService, useValue: pushConfig }],
    }).compile();

    controller = module.get(AdminNotificationsController);
  });

  it("requires the admin role for the whole controller", () => {
    expect(
      new Reflector().get(ROLES_KEY, AdminNotificationsController),
    ).toEqual(["admin"]);
  });

  it("is demo-restricted for the whole controller", () => {
    expect(
      new Reflector().get(DEMO_RESTRICTED_KEY, AdminNotificationsController),
    ).toBe(true);
  });

  it("switches the instance channel from the payload", async () => {
    await controller.updateChannels({ webPushEnabled: false });

    expect(pushConfig.setWebPushEnabled).toHaveBeenCalledWith(false);
  });

  // How many devices a rotation retired is part of the answer, not a log line:
  // every one of them has to subscribe again before it can be reached.
  it("reports how many devices a rotation retired", async () => {
    const result = await controller.rotate();

    expect(result).toEqual({
      config: { enabled: true },
      disabledSubscriptions: 3,
    });
  });

  // The administrator configures the instance and never reaches an account's
  // devices or notifications. A route that did would be a new leak, not a
  // feature, so the surface is pinned.
  it("exposes only instance-level routes", () => {
    const methods = Object.getOwnPropertyNames(
      AdminNotificationsController.prototype,
    ).filter((name) => name !== "constructor");

    expect(methods.sort()).toEqual(["getChannels", "rotate", "updateChannels"]);
  });
});
