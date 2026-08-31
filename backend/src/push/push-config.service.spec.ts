import * as webpush from "web-push";
import { PushConfigService, fingerprintPublicKey } from "./push-config.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { PushInstanceConfig } from "./entities/push-instance-config.entity";
import {
  PushSubscription,
  PushDisabledReason,
} from "./entities/push-subscription.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("web-push", () => ({
  generateVAPIDKeys: jest.fn(),
  sendNotification: jest.fn(),
}));

const generateVAPIDKeys = webpush.generateVAPIDKeys as jest.Mock;

function storedConfig(overrides: Partial<PushInstanceConfig> = {}) {
  return {
    id: true,
    vapidPublicKey: "PUB-STORED",
    vapidPrivateKeyEnc: "enc(PRIV-STORED)",
    vapidGeneratedAt: new Date("2026-01-02T03:04:05Z"),
    webPushEnabled: true,
    updatedAt: new Date("2026-01-02T03:04:05Z"),
    ...overrides,
  } as PushInstanceConfig;
}

describe("PushConfigService", () => {
  let service: PushConfigService;
  let configRepo: Record<string, jest.Mock>;
  let subscriptionRepo: Record<string, jest.Mock>;
  let manager: ReturnType<typeof createScopedDbMocks>["manager"];
  let dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  let encryption: {
    isConfigured: jest.Mock;
    encrypt: jest.Mock;
    decrypt: jest.Mock;
    canDecrypt: jest.Mock;
  };

  /** Which transaction each `manager.query` ran inside, in call order. */
  let queryTransactionIds: number[];

  beforeEach(() => {
    jest.clearAllMocks();
    configRepo = { findOne: jest.fn().mockResolvedValue(null) };
    subscriptionRepo = { count: jest.fn().mockResolvedValue(0) };
    ({ manager, dataSource } = createScopedDbMocks([
      [PushInstanceConfig, configRepo],
      [PushSubscription, subscriptionRepo],
    ]));
    // Stamp every query with the transaction it ran inside, so a spec can hold
    // "these two writes are atomic" rather than "these two writes happened".
    // Give every transaction its own manager whose `query` stamps the
    // transaction it ran inside, so a spec can hold "these two writes are
    // atomic" rather than the much weaker "these two writes happened". A
    // mutable "current transaction" variable cannot do this: the callback is
    // async, so it yields at its first await and any restore-on-exit runs
    // before the second statement.
    queryTransactionIds = [];
    let nextTransactionId = 0;
    dataSource.transaction.mockImplementation((...args: unknown[]) => {
      nextTransactionId += 1;
      const id = nextTransactionId;
      const fn = (typeof args[0] === "function" ? args[0] : args[1]) as (
        m: unknown,
      ) => unknown;
      const txManager = Object.create(manager) as typeof manager;
      txManager.query = jest.fn((...queryArgs: unknown[]) => {
        queryTransactionIds.push(id);
        return manager.query(...queryArgs);
      });
      return fn(txManager);
    });
    manager.query.mockResolvedValue([[], 0]);
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((plain: string) => `enc(${plain})`),
      decrypt: jest.fn((cipher: string) =>
        cipher.replace(/^enc\((.*)\)$/, "$1"),
      ),
      canDecrypt: jest.fn().mockReturnValue(true),
    };
    generateVAPIDKeys.mockReturnValue({
      publicKey: "PUB-NEW",
      privateKey: "PRIV-NEW",
    });
    service = new PushConfigService(
      dataSource as never,
      encryption as unknown as EncryptionService,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  describe("ensureKeyPair", () => {
    it("generates a pair on first start and stores the private half encrypted", async () => {
      configRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedConfig({ vapidPublicKey: "PUB-NEW" }));

      await service.ensureKeyPair();

      expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("INSERT INTO push_instance_config");
      expect(params).toEqual(["PUB-NEW", "enc(PRIV-NEW)"]);
      // The plaintext private key must never reach a parameter.
      expect(JSON.stringify(params)).not.toContain('PRIV-NEW"');
    });

    // The whole point of a singleton table: a second start reuses the identity
    // rather than minting one every boot and orphaning every subscription.
    it("reuses an existing pair without generating anything", async () => {
      configRepo.findOne.mockResolvedValue(storedConfig());

      const result = await service.ensureKeyPair();

      expect(result?.vapidPublicKey).toBe("PUB-STORED");
      expect(generateVAPIDKeys).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("stores nothing at all when ENCRYPTION_KEY is absent", async () => {
      encryption.isConfigured.mockReturnValue(false);

      await expect(service.ensureKeyPair()).resolves.toBeNull();

      expect(generateVAPIDKeys).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      // One transaction, and it is the read that discovered there was no row.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    // Several replicas run the bootstrap hook; the insert is the arbiter and the
    // loser must return the winner's row, never the values it tried to insert.
    it("returns the row the winning replica committed after a conflict", async () => {
      configRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedConfig({ vapidPublicKey: "PUB-WINNER" }));

      const result = await service.ensureKeyPair();

      expect(result?.vapidPublicKey).toBe("PUB-WINNER");
      expect(manager.query.mock.calls[0][0]).toContain(
        "ON CONFLICT (id) DO NOTHING",
      );
    });

    it("does not let a bootstrap failure stop the application starting", async () => {
      configRepo.findOne.mockRejectedValue(new Error("database asleep"));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe("getPublicConfig", () => {
    it("hands the browser the public key and nothing else", async () => {
      configRepo.findOne.mockResolvedValue(storedConfig());

      const config = await service.getPublicConfig();

      expect(config).toEqual({
        enabled: true,
        publicKey: "PUB-STORED",
        configured: true,
      });
      expect(Object.keys(config)).not.toContain("privateKey");
      expect(JSON.stringify(config)).not.toContain("PRIV");
    });

    it("separates 'no key pair' from 'channel switched off'", async () => {
      configRepo.findOne.mockResolvedValue(null);
      await expect(service.getPublicConfig()).resolves.toEqual({
        enabled: false,
        publicKey: null,
        configured: false,
      });

      configRepo.findOne.mockResolvedValue(
        storedConfig({ webPushEnabled: false }),
      );
      await expect(service.getPublicConfig()).resolves.toEqual({
        enabled: false,
        publicKey: "PUB-STORED",
        configured: true,
      });
    });
  });

  describe("getAdminConfig", () => {
    it("reports device counts and a fingerprint, never the private key", async () => {
      configRepo.findOne.mockResolvedValue(storedConfig());
      subscriptionRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

      const config = await service.getAdminConfig();

      expect(config).toEqual({
        enabled: true,
        publicKey: "PUB-STORED",
        configured: true,
        publicKeyFingerprint: fingerprintPublicKey("PUB-STORED"),
        generatedAt: "2026-01-02T03:04:05.000Z",
        liveSubscriptionCount: 3,
        disabledSubscriptionCount: 1,
      });
      expect(JSON.stringify(config)).not.toContain("enc(");
    });
  });

  describe("getVapidIdentity", () => {
    it("decrypts the private half for the sender", async () => {
      configRepo.findOne.mockResolvedValue(storedConfig());

      await expect(service.getVapidIdentity()).resolves.toEqual({
        publicKey: "PUB-STORED",
        privateKey: "PRIV-STORED",
      });
    });

    it("withholds the identity when the channel is switched off", async () => {
      configRepo.findOne.mockResolvedValue(
        storedConfig({ webPushEnabled: false }),
      );

      await expect(service.getVapidIdentity()).resolves.toBeNull();
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    // A pair this instance cannot open happens when ENCRYPTION_KEY changes under
    // a live database. Returning null names it; letting AES-GCM throw does not.
    it("withholds the identity, and does not throw, when the stored pair cannot be decrypted", async () => {
      configRepo.findOne.mockResolvedValue(storedConfig());
      encryption.canDecrypt.mockReturnValue(false);

      await expect(service.getVapidIdentity()).resolves.toBeNull();
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });
  });

  describe("rotateKeyPair", () => {
    it("replaces the pair and retires every subscription in one transaction", async () => {
      configRepo.findOne.mockResolvedValue(
        storedConfig({ vapidPublicKey: "PUB-NEW" }),
      );
      manager.query
        .mockResolvedValueOnce([[], 1]) // the upsert
        .mockResolvedValueOnce([[], 4]); // the disable

      const result = await service.rotateKeyPair();

      expect(result.disabled).toBe(4);
      const [upsertSql] = manager.query.mock.calls[0];
      const [disableSql, disableParams] = manager.query.mock.calls[1];
      expect(upsertSql).toContain("ON CONFLICT (id) DO UPDATE");
      expect(disableSql).toContain("UPDATE push_subscriptions");
      expect(disableParams).toEqual([
        PushDisabledReason.KEY_ROTATED,
        "PUB-NEW",
      ]);
      expect(manager.query).toHaveBeenCalledTimes(2);
      // Both writes in ONE transaction, asserted by transaction boundary and not
      // merely by call count: a new key pair with live subscriptions still under
      // the old one is an interface listing devices it cannot reach, and a
      // half-applied rotation is exactly what a second transaction would allow.
      expect(new Set(queryTransactionIds).size).toBe(1);
    });

    it("refuses to rotate when there is nowhere safe to put the new private key", async () => {
      encryption.isConfigured.mockReturnValue(false);
      configRepo.findOne.mockResolvedValue(null);

      const result = await service.rotateKeyPair();

      expect(result.disabled).toBe(0);
      expect(generateVAPIDKeys).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe("fingerprintPublicKey", () => {
    it("is stable, short and different for different keys", () => {
      expect(fingerprintPublicKey("A")).toBe(fingerprintPublicKey("A"));
      expect(fingerprintPublicKey("A")).not.toBe(fingerprintPublicKey("B"));
      expect(fingerprintPublicKey("A")).toHaveLength(16);
    });
  });
});
