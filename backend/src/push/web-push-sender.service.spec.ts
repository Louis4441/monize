import * as webpush from "web-push";
import {
  WebPushSender,
  MAX_CONSECUTIVE_FAILURES,
} from "./web-push-sender.service";
import { PushConfigService, VAPID_SUBJECT } from "./push-config.service";
import { PushDisabledReason } from "./entities/push-subscription.entity";

jest.mock("web-push", () => ({
  sendNotification: jest.fn(),
  generateVAPIDKeys: jest.fn(),
}));

const sendNotification = webpush.sendNotification as jest.Mock;

const IDENTITY = { publicKey: "PUB-CURRENT", privateKey: "PRIV" };

function target(overrides: Partial<Parameters<WebPushSender["send"]>[0]> = {}) {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    p256dh: "p256dh-value",
    auth: "auth-value",
    vapidPublicKey: "PUB-CURRENT",
    ...overrides,
  };
}

const PAYLOAD = { type: "TEST", title: "t", body: "b", target: "/settings" };

describe("WebPushSender", () => {
  let sender: WebPushSender;
  let pushConfig: { getVapidIdentity: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    pushConfig = { getVapidIdentity: jest.fn().mockResolvedValue(IDENTITY) };
    sender = new WebPushSender(pushConfig as unknown as PushConfigService);
    jest.spyOn(sender["logger"], "warn").mockImplementation(() => undefined);
  });

  it("signs with the instance identity and reports a send", async () => {
    sendNotification.mockResolvedValue(undefined);

    await expect(sender.send(target(), PAYLOAD)).resolves.toEqual({
      status: "sent",
    });

    const [subscription, body, options] = sendNotification.mock.calls[0];
    expect(subscription).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    expect(JSON.parse(body)).toEqual(PAYLOAD);
    expect(options.vapidDetails).toEqual({
      subject: VAPID_SUBJECT,
      publicKey: "PUB-CURRENT",
      privateKey: "PRIV",
    });
  });

  it("reports unconfigured, and sends nothing, when the instance has no usable identity", async () => {
    pushConfig.getVapidIdentity.mockResolvedValue(null);

    await expect(sender.send(target(), PAYLOAD)).resolves.toEqual({
      status: "unconfigured",
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("refuses a subscription minted under a superseded key pair without calling out", async () => {
    await expect(
      sender.send(target({ vapidPublicKey: "PUB-OLD" }), PAYLOAD),
    ).resolves.toEqual({
      status: "expired",
      reason: PushDisabledReason.KEY_ROTATED,
    });
    // The push service would answer 403; asking it costs a round trip and tells
    // us nothing we do not already know from the stored key.
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it.each([404, 410])(
    "treats %s from the push service as a gone subscription",
    async (statusCode) => {
      sendNotification.mockRejectedValue(
        Object.assign(new Error("gone"), { statusCode }),
      );

      await expect(sender.send(target(), PAYLOAD)).resolves.toEqual({
        status: "expired",
        reason: PushDisabledReason.GONE,
        statusCode,
      });
    },
  );

  // The regression this pins: retiring a device on an authorization failure
  // would empty every device list in the deployment over one bad clock or key.
  it.each([400, 401, 403, 413, 429, 500, 503])(
    "treats %s as transient rather than retiring the device",
    async (statusCode) => {
      sendNotification.mockRejectedValue(
        Object.assign(new Error("nope"), { statusCode }),
      );

      const outcome = await sender.send(target(), PAYLOAD);

      expect(outcome).toEqual({
        status: "transient",
        message: "nope",
        statusCode,
      });
    },
  );

  it("treats a transport error with no status code as transient", async () => {
    sendNotification.mockRejectedValue(new Error("socket hang up"));

    await expect(sender.send(target(), PAYLOAD)).resolves.toEqual({
      status: "transient",
      message: "socket hang up",
      statusCode: undefined,
    });
  });

  it("never throws, whatever the transport rejects with", async () => {
    sendNotification.mockRejectedValue("a bare string");

    await expect(sender.send(target(), PAYLOAD)).resolves.toEqual({
      status: "transient",
      message: "unknown push failure",
      statusCode: undefined,
    });
  });

  it("bounds retry at a value a working device never reaches", () => {
    // The constant is the whole of "bounded retry"; a spec that did not name it
    // would let it be raised to Infinity without a failure.
    expect(MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(1);
    expect(Number.isFinite(MAX_CONSECUTIVE_FAILURES)).toBe(true);
  });
});
