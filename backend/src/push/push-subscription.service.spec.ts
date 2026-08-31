import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import {
  PushSubscriptionService,
  ENDPOINT_FINGERPRINT_LENGTH,
  MAX_USER_AGENT_LENGTH,
  hashEndpoint,
} from "./push-subscription.service";
import { PushConfigService } from "./push-config.service";
import {
  MAX_CONSECUTIVE_FAILURES,
  WebPushSender,
} from "./web-push-sender.service";
import {
  PushDisabledReason,
  PushSubscription,
} from "./entities/push-subscription.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/abcdef";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";

const DTO = {
  endpoint: ENDPOINT,
  p256dh: "p256dh-value",
  auth: "auth-value",
  deviceName: "Pixel 9",
};

function storedDevice(overrides: Partial<PushSubscription> = {}) {
  return {
    id: DEVICE_ID,
    userId: USER,
    endpoint: ENDPOINT,
    endpointHash: hashEndpoint(ENDPOINT),
    p256dh: "p256dh-value",
    auth: "auth-value",
    deviceName: "Pixel 9",
    userAgent: "Mozilla/5.0",
    vapidPublicKey: "PUB",
    createdAt: new Date("2026-08-01T10:00:00Z"),
    lastSeenAt: new Date("2026-08-02T10:00:00Z"),
    lastSuccessAt: null,
    failureCount: 0,
    disabledAt: null,
    disabledReason: null,
    ...overrides,
  } as PushSubscription;
}

describe("PushSubscriptionService", () => {
  let service: PushSubscriptionService;
  let subscriptionRepo: Record<string, jest.Mock>;
  let preferenceRepo: Record<string, jest.Mock>;
  let manager: ReturnType<typeof createScopedDbMocks>["manager"];
  let dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  let pushConfig: { getPublicConfig: jest.Mock };
  let sender: { send: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    subscriptionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(storedDevice()),
    };
    preferenceRepo = {
      findOne: jest.fn().mockResolvedValue({ language: "en" }),
    };
    ({ manager, dataSource } = createScopedDbMocks([
      [PushSubscription, subscriptionRepo],
      [UserPreference, preferenceRepo],
    ]));
    manager.query.mockResolvedValue([[{ id: DEVICE_ID }], 1]);
    pushConfig = {
      getPublicConfig: jest.fn().mockResolvedValue({
        enabled: true,
        publicKey: "PUB",
        configured: true,
      }),
    };
    sender = { send: jest.fn().mockResolvedValue({ status: "sent" }) };
    service = new PushSubscriptionService(
      dataSource as never,
      pushConfig as unknown as PushConfigService,
      sender as unknown as WebPushSender,
      { translate: jest.fn((key: string) => key) } as unknown as I18nService,
    );
  });

  describe("subscribe", () => {
    it("binds the owner from its own argument and never from the payload", async () => {
      await service.subscribe(USER, DTO, "Mozilla/5.0");

      const insert = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO push_subscriptions"),
      );
      expect(insert).toBeDefined();
      expect(insert![1][0]).toBe(USER);
      // A payload-supplied owner is not merely ignored: there is no field for it.
      expect(Object.keys(DTO)).not.toContain("userId");
    });

    // The rule this pins, and the reason the previous shape was wrong: an
    // endpoint is a string the caller supplied, and it proves nothing about
    // what they own. Deleting another account's row on the strength of it was a
    // cross-tenant destructive write -- and a silent one, so the first account
    // lost push with no notice. One row per endpoint, and the second subscriber
    // is refused.
    it("touches no row belonging to another account", async () => {
      await service.subscribe(USER, DTO, null);

      const sqls = manager.query.mock.calls.map(([sql]) => String(sql));
      expect(sqls.some((sql) => sql.includes("DELETE"))).toBe(false);
      for (const [sql, params] of manager.query.mock.calls) {
        // Every statement this path issues is scoped to the caller, either by
        // an explicit predicate or by the value it inserts.
        expect(String(sql)).not.toContain("user_id <>");
        expect(params).toContain(USER);
      }
    });

    it("refuses when the endpoint is registered to another account", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        ConflictException,
      );
      expect(subscriptionRepo.findOne).not.toHaveBeenCalled();
    });

    it("only writes its own row on the conflict arm", async () => {
      await service.subscribe(USER, DTO, null);

      const [sql] = manager.query.mock.calls.find(([s]) =>
        String(s).includes("INSERT INTO push_subscriptions"),
      )!;
      expect(sql).toContain("ON CONFLICT (endpoint_hash) DO UPDATE");
      expect(sql).toContain(
        "WHERE push_subscriptions.user_id = EXCLUDED.user_id",
      );
      // A re-subscribe from a device that had been retired must come back live.
      expect(sql).toContain("disabled_at = NULL");
      expect(sql).toContain("failure_count = 0");
    });

    // The response is a read model: on the DO UPDATE arm the stored device name
    // may be the one already there (COALESCE), which this request never saw.
    it("builds the response from the committed row, not from the request", async () => {
      subscriptionRepo.findOne.mockResolvedValue(
        storedDevice({ deviceName: "Name set on an earlier subscribe" }),
      );

      const result = await service.subscribe(USER, DTO, null);

      expect(result.deviceName).toBe("Name set on an earlier subscribe");
      expect(subscriptionRepo.findOne).toHaveBeenCalledWith({
        where: { id: DEVICE_ID },
      });
    });

    it("refuses when the instance has push switched off", async () => {
      pushConfig.getPublicConfig.mockResolvedValue({
        enabled: false,
        publicKey: "PUB",
        configured: true,
      });

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("refuses when the instance holds no key pair, so no subscription is stored under a null key", async () => {
      pushConfig.getPublicConfig.mockResolvedValue({
        enabled: true,
        publicKey: null,
        configured: false,
      });

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("truncates a user agent to what the column holds", async () => {
      await service.subscribe(USER, DTO, "U".repeat(400));

      const insert = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO push_subscriptions"),
      )!;
      expect(insert[1][6]).toHaveLength(MAX_USER_AGENT_LENGTH);
    });

    it("stamps the subscription with the key pair it was minted under", async () => {
      await service.subscribe(USER, DTO, null);

      const insert = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO push_subscriptions"),
      )!;
      expect(insert[1][7]).toBe("PUB");
    });
  });

  describe("listForUser", () => {
    it("lists only the caller's own devices", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      const devices = await service.listForUser(USER);

      expect(subscriptionRepo.find).toHaveBeenCalledWith({
        where: { userId: USER },
        order: { lastSeenAt: "DESC" },
      });
      expect(devices).toHaveLength(1);
      // A device list is not a place to publish transport credentials: the
      // endpoint plus the two keys are all anyone needs to push to that device.
      expect(Object.keys(devices[0])).not.toContain("endpoint");
      expect(Object.keys(devices[0])).not.toContain("p256dh");
      expect(Object.keys(devices[0])).not.toContain("auth");
      // What it does carry is a digest prefix, so a browser can recognise the
      // row that is itself without the endpoint being handed back.
      expect(devices[0].endpointFingerprint).toBe(
        hashEndpoint(ENDPOINT).slice(0, ENDPOINT_FINGERPRINT_LENGTH),
      );
      expect(devices[0].endpointFingerprint.length).toBeLessThan(
        hashEndpoint(ENDPOINT).length,
      );
    });
  });

  describe("remove", () => {
    it("scopes the delete to the caller inside the transaction that performs it", async () => {
      manager.query.mockResolvedValue([[], 1]);

      await service.remove(USER, DEVICE_ID);

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("WHERE id = $1 AND user_id = $2");
      expect(params).toEqual([DEVICE_ID, USER]);
    });

    it("reports a device that is not the caller's as missing", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await expect(service.remove(OTHER_USER, DEVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("sendTest", () => {
    it("refuses when the instance has push switched off", async () => {
      pushConfig.getPublicConfig.mockResolvedValue({
        enabled: false,
        publicKey: null,
        configured: false,
      });

      await expect(service.sendTest(USER)).rejects.toThrow(BadRequestException);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("refuses, rather than reporting success over nothing, when no device is registered", async () => {
      subscriptionRepo.find.mockResolvedValue([]);

      await expect(service.sendTest(USER)).rejects.toThrow(BadRequestException);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("sends only to the caller's live devices", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      await service.sendTest(USER);

      const [[where]] = subscriptionRepo.find.mock.calls;
      expect(where.where.userId).toBe(USER);
      expect(where.where.disabledAt).toBeDefined();
      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    it("carries no financial detail across the push service", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      await service.sendTest(USER);

      const [, payload] = sender.send.mock.calls[0];
      expect(Object.keys(payload).sort()).toEqual([
        "body",
        "target",
        "title",
        "type",
      ]);
      expect(payload.type).toBe("TEST");
      expect(payload.target.startsWith("/")).toBe(true);
    });

    it("renders the body in the recipient's stored language", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      preferenceRepo.findOne.mockResolvedValue({ language: "pl" });
      const translate = jest.fn(
        (key: string) => `PL:${key}`,
      ) as unknown as I18nService["translate"];
      service = new PushSubscriptionService(
        dataSource as never,
        pushConfig as unknown as PushConfigService,
        sender as unknown as WebPushSender,
        { translate } as unknown as I18nService,
      );

      await service.sendTest(USER);

      expect(translate).toHaveBeenCalledWith(
        "push.test.title",
        expect.objectContaining({ lang: "pl" }),
      );
      const [, payload] = sender.send.mock.calls[0];
      expect(payload.title).toBe("PL:push.test.title");
    });

    it("records a success by clearing the failure count", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      const result = await service.sendTest(USER);

      expect(result).toEqual({
        attempted: 1,
        delivered: 1,
        devices: [{ id: DEVICE_ID, deviceName: "Pixel 9", status: "sent" }],
      });
      const update = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("last_success_at"),
      )!;
      expect(update[0]).toContain("failure_count = 0");
      expect(update[1]).toEqual([DEVICE_ID, USER]);
    });

    it("retires a device the push service says is gone", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({
        status: "expired",
        reason: PushDisabledReason.GONE,
        statusCode: 410,
      });

      const result = await service.sendTest(USER);

      expect(result.delivered).toBe(0);
      expect(result.devices[0]).toEqual({
        id: DEVICE_ID,
        deviceName: "Pixel 9",
        status: "expired",
        disabledReason: PushDisabledReason.GONE,
      });
      const update = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("disabled_reason = $3"),
      )!;
      expect(update[1]).toEqual([DEVICE_ID, USER, PushDisabledReason.GONE]);
    });

    it("counts a transient failure without retiring the device", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({ status: "transient", message: "503" });
      manager.query.mockResolvedValue([[{ disabled_reason: null }], 1]);

      const result = await service.sendTest(USER);

      expect(result.devices[0].status).toBe("transient");
      expect(result.devices[0].disabledReason).toBeUndefined();
      const update = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("failure_count = failure_count + 1"),
      )!;
      expect(update[1]).toEqual([
        DEVICE_ID,
        USER,
        MAX_CONSECUTIVE_FAILURES,
        PushDisabledReason.FAILING,
      ]);
    });

    it("retires a device once the retry bound is reached", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({ status: "transient", message: "503" });
      manager.query.mockResolvedValue([
        [{ disabled_reason: PushDisabledReason.FAILING }],
        1,
      ]);

      const result = await service.sendTest(USER);

      expect(result.devices[0].disabledReason).toBe(PushDisabledReason.FAILING);
    });

    it("writes no bookkeeping when the instance could not sign at all", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({ status: "unconfigured" });

      const result = await service.sendTest(USER);

      expect(result.delivered).toBe(0);
      expect(manager.query).not.toHaveBeenCalled();
    });

    // A failed delivery is reported, never raised: the notification must not be
    // able to undo whatever produced it.
    it("reports a per-device failure instead of throwing", async () => {
      subscriptionRepo.find.mockResolvedValue([
        storedDevice(),
        storedDevice({ id: "44444444-4444-4444-8444-444444444444" }),
      ]);
      sender.send
        .mockResolvedValueOnce({ status: "transient", message: "503" })
        .mockResolvedValueOnce({ status: "sent" });
      manager.query.mockResolvedValue([[{ disabled_reason: null }], 1]);

      const result = await service.sendTest(USER);

      expect(result).toMatchObject({ attempted: 2, delivered: 1 });
      expect(result.devices.map((d) => d.status)).toEqual([
        "transient",
        "sent",
      ]);
    });
  });

  describe("hashEndpoint", () => {
    it("is a stable 64-character digest, so the index can hold an unbounded URL", () => {
      expect(hashEndpoint(ENDPOINT)).toHaveLength(64);
      expect(hashEndpoint(ENDPOINT)).toBe(hashEndpoint(ENDPOINT));
      expect(hashEndpoint(ENDPOINT)).not.toBe(hashEndpoint(`${ENDPOINT}x`));
    });
  });
});
