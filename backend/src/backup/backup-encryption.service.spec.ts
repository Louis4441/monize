import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  BackupEncryptionService,
  BackupKeyResolution,
} from "./backup-encryption.service";
import { User } from "../users/entities/user.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { PasswordBreachService } from "../auth/password-breach.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createKeyWrappedEncryptStream,
  createWrappedBackupKey,
  loginPasswordRef,
  unwrapBackupKey,
  WrappedBackupKey,
} from "./backup-key-wrap";
import { decryptBackup } from "./backup-crypto.util";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("bcryptjs");

/** The columns `storeBackupKey` writes, as a spec reads them back off `update`. */
interface StoredKeyColumns {
  backupKeyEnc: string;
  backupKeyWrap: string;
  backupKeyPasswordRef: string | null;
  backupPasswordEnc: null;
  backupEncryptionEnabled: true;
}

/** Encrypt `payload` exactly as the automatic backup does, under a stored key. */
async function sealUnder(
  key: WrappedBackupKey,
  payload: Buffer,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([payload]),
    createKeyWrappedEncryptStream(key),
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) chunks.push(chunk);
    },
  );
  return Buffer.concat(chunks);
}

describe("BackupEncryptionService", () => {
  let service: BackupEncryptionService;
  let usersRepo: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let passwordBreach: Record<string, jest.Mock>;
  let scopedDataSource: { transaction: jest.Mock };

  const userId = "user-1";
  const hash = "bcrypt-hash";

  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: userId,
      authProvider: "local",
      passwordHash: hash,
      backupEncryptionEnabled: false,
      backupPasswordEnc: null,
      backupKeyEnc: null,
      backupKeyWrap: null,
      backupKeyPasswordRef: null,
      ...overrides,
    } as User;
  }

  /** The row as `storeBackupKey` leaves it, for a key wrapped under `password`. */
  async function keyedUser(
    password: string,
    boundHash: string | null,
    overrides: Partial<User> = {},
  ): Promise<{ user: User; key: WrappedBackupKey }> {
    const key = await createWrappedBackupKey(password);
    const user = makeUser({
      backupEncryptionEnabled: true,
      backupKeyEnc: `enc:${key.dataKey.toString("base64")}`,
      backupKeyWrap: key.wrap.toString("base64"),
      backupKeyPasswordRef: boundHash ? loginPasswordRef(boundHash) : null,
      ...overrides,
    });
    return { user, key };
  }

  /** The single `update` call's criteria and values. */
  function onlyUpdate(): [Record<string, unknown>, StoredKeyColumns] {
    expect(usersRepo.update).toHaveBeenCalledTimes(1);
    return usersRepo.update.mock.calls[0] as [
      Record<string, unknown>,
      StoredKeyColumns,
    ];
  }

  /**
   * The finding this suite exists to hold: nothing stored decrypts to the
   * password. The retired column is cleared, no column contains it, the one
   * ciphertext the server can open holds a random 32-byte key, and the wrap
   * gives that key back only to the password.
   */
  async function expectNoRecoverablePassword(
    stored: StoredKeyColumns,
    password: string,
  ): Promise<Buffer> {
    expect(stored.backupPasswordEnc).toBeNull();
    for (const value of Object.values(stored)) {
      expect(String(value)).not.toContain(password);
    }
    const serverReadable = encryption.decrypt(stored.backupKeyEnc) as string;
    expect(serverReadable).not.toBe(password);
    const dataKey = Buffer.from(serverReadable, "base64");
    expect(dataKey).toHaveLength(32);
    const unwrapped = await unwrapBackupKey(
      Buffer.from(stored.backupKeyWrap, "base64"),
      password,
    );
    expect(unwrapped.equals(dataKey)).toBe(true);
    return dataKey;
  }

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((s: string) => `enc:${s}`),
      decrypt: jest.fn((s: string) => s.replace(/^enc:/, "")),
    };
    passwordBreach = {
      isBreached: jest.fn().mockResolvedValue(false),
    };

    scopedDataSource = createScopedDbMocks([[User, usersRepo as never]])
      .dataSource as unknown as { transaction: jest.Mock };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DataSource,
          useValue: scopedDataSource,
        },
        BackupEncryptionService,
        { provide: EncryptionService, useValue: encryption },
        { provide: PasswordBreachService, useValue: passwordBreach },
      ],
    }).compile();

    service = module.get(BackupEncryptionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("getStatus", () => {
    it("reports a local user's encryption as enabled but not theirs to manage", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ backupEncryptionEnabled: true }),
      );
      // Their key is re-made under the login password at sign-in, so Settings
      // offers them nothing to change.
      expect(await service.getStatus(userId)).toEqual({
        enabled: true,
        manageable: false,
        method: "login-password",
        available: true,
      });
    });

    it("reports an OIDC user's encryption as theirs to manage", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      expect(await service.getStatus(userId)).toEqual({
        enabled: false,
        manageable: true,
        method: "backup-password",
        available: true,
      });
    });

    it("throws when user not found", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.getStatus(userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("reports a server that cannot encrypt at all as unavailable", async () => {
      // "Off because this server holds no key" and "off because this user has
      // not turned it on" are two different facts with two different fixes, and
      // a screen that shows only `enabled` cannot tell them apart -- which is
      // how issue #1269 stayed invisible on the Settings page.
      encryption.isConfigured.mockReturnValue(false);
      usersRepo.findOne.mockResolvedValue(makeUser());

      expect(await service.getStatus(userId)).toEqual({
        enabled: false,
        manageable: false,
        method: "login-password",
        available: false,
      });
    });
  });

  describe("enableWithLoginPassword", () => {
    it("wraps a key under the confirmed login password and turns encryption on", async () => {
      // The path that rescues a session older than the deploy which shipped the
      // sign-in wrap: nothing else would ask this user for their password
      // again, so their backups would stay plaintext for the life of the
      // session.
      usersRepo.findOne.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.enableWithLoginPassword(userId, "hunter2hunter2");

      expect(bcrypt.compare).toHaveBeenCalledWith("hunter2hunter2", hash);
      expect(usersRepo.save).not.toHaveBeenCalled();
      const [criteria, stored] = onlyUpdate();
      // Only while the hash just compared is still the account's.
      expect(criteria).toEqual({ id: userId, passwordHash: hash });
      expect(stored.backupEncryptionEnabled).toBe(true);
      expect(stored.backupKeyPasswordRef).toBe(loginPasswordRef(hash));
      await expectNoRecoverablePassword(stored, "hunter2hunter2");
    });

    it("refuses a password that is not the account's, and writes nothing", async () => {
      // Wrapping under an unverified string would encrypt every future backup
      // under a password the user only thinks they know -- a file that looks
      // like a backup and never opens.
      usersRepo.findOne.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.enableWithLoginPassword(userId, "not-my-password"),
      ).rejects.toThrow(UnauthorizedException);

      expect(usersRepo.update).not.toHaveBeenCalled();
      expect(encryption.encrypt).not.toHaveBeenCalled();
    });

    it("refuses when the password changed under the write", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      usersRepo.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.enableWithLoginPassword(userId, "hunter2hunter2"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("refuses an OIDC account, which has no login password of ours", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );

      await expect(
        service.enableWithLoginPassword(userId, "hunter2hunter2"),
      ).rejects.toThrow(BadRequestException);

      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("refuses when the server holds no key, rather than storing something unreadable", async () => {
      encryption.isConfigured.mockReturnValue(false);
      usersRepo.findOne.mockResolvedValue(makeUser());

      await expect(
        service.enableWithLoginPassword(userId, "hunter2hunter2"),
      ).rejects.toThrow(BadRequestException);

      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("throws when the user no longer exists", async () => {
      usersRepo.findOne.mockResolvedValue(null);

      await expect(
        service.enableWithLoginPassword(userId, "hunter2hunter2"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("rewrapBackupKey", () => {
    it("wraps a key under the password without storing anything that decrypts to it", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());

      await service.rewrapBackupKey(userId, "hunter2hunter2", hash);

      // A targeted update, not a full-entity save. `save` on a loaded entity
      // writes every column from the snapshot, so it silently reverted any
      // concurrent change to the users row -- `last_activity_at`, a lockout
      // counter, an admin disabling the account.
      expect(usersRepo.save).not.toHaveBeenCalled();
      const [criteria, stored] = onlyUpdate();
      expect(criteria).toEqual({ id: userId, passwordHash: hash });
      expect(stored.backupKeyPasswordRef).toBe(loginPasswordRef(hash));
      expect(encryption.encrypt).not.toHaveBeenCalledWith("hunter2hunter2");
      await expectNoRecoverablePassword(stored, "hunter2hunter2");
    });

    it("converts a row still holding the retired password copy, clearing it", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:hunter2hunter2",
        }),
      );

      await service.rewrapBackupKey(userId, "hunter2hunter2", hash);

      const [, stored] = onlyUpdate();
      await expectNoRecoverablePassword(stored, "hunter2hunter2");
    });

    it("re-wraps under a fresh key after a password change", async () => {
      const { user, key } = await keyedUser("old-password", "old-hash", {
        passwordHash: "new-hash",
      });
      usersRepo.findOne.mockResolvedValue(user);

      await service.rewrapBackupKey(userId, "new-password", "new-hash");

      const [criteria, stored] = onlyUpdate();
      expect(criteria).toEqual({ id: userId, passwordHash: "new-hash" });
      expect(stored.backupKeyPasswordRef).toBe(loginPasswordRef("new-hash"));
      const dataKey = await expectNoRecoverablePassword(stored, "new-password");
      // A fresh key, so the old password together with an old file cannot open
      // what is written from now on.
      expect(dataKey.equals(key.dataKey)).toBe(false);
      await expect(
        unwrapBackupKey(
          Buffer.from(stored.backupKeyWrap, "base64"),
          "old-password",
        ),
      ).rejects.toThrow();
    });

    it("writes nothing on a sign-in whose wrap is already current", async () => {
      // Skipping is what keeps ~100ms of scrypt off every login.
      const { user } = await keyedUser("hunter2hunter2", hash);
      usersRepo.findOne.mockResolvedValue(user);

      await service.rewrapBackupKey(userId, "hunter2hunter2", hash);

      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("stores nothing for an OIDC account", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );

      await service.rewrapBackupKey(userId, "hunter2hunter2", hash);

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("stores nothing when the server has no encryption key", async () => {
      encryption.isConfigured.mockReturnValue(false);
      usersRepo.findOne.mockResolvedValue(makeUser());

      await service.rewrapBackupKey(userId, "hunter2hunter2", hash);

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("stores nothing for a user that no longer exists", async () => {
      usersRepo.findOne.mockResolvedValue(null);

      await service.rewrapBackupKey(userId, "hunter2hunter2", hash);

      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("swallows a storage failure rather than breaking sign-in", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());
      usersRepo.update.mockRejectedValue(new Error("db down"));

      await expect(
        service.rewrapBackupKey(userId, "hunter2hunter2", hash),
      ).resolves.toBeUndefined();
    });
  });

  describe("resolveBackupKey", () => {
    const payload = Buffer.from("gzipped backup payload");

    async function sealedWith(resolution: BackupKeyResolution) {
      expect(resolution.status).toBe("key");
      if (resolution.status !== "key") throw new Error("unreachable");
      return sealUnder(resolution.key, payload);
    }

    it("returns 'none' when nothing is stored", async () => {
      expect(await service.resolveBackupKey(makeUser())).toEqual({
        status: "none",
      });
    });

    it("hands the cron a key that encrypts without the password, and the file opens with it", async () => {
      const { user } = await keyedUser("hunter2hunter2", hash);

      const resolution = await service.resolveBackupKey(user);

      // No password anywhere in the resolution; the envelope opens with it.
      expect(JSON.stringify(resolution)).not.toContain("hunter2hunter2");
      const envelope = await sealedWith(resolution);
      expect(
        (await decryptBackup(envelope, "hunter2hunter2")).equals(payload),
      ).toBe(true);
      await expect(decryptBackup(envelope, "wrong-password")).rejects.toThrow();
      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("uses an OIDC dedicated-password key, which has no login hash to go stale against", async () => {
      const { user } = await keyedUser("dedicated-password", null, {
        authProvider: "oidc",
        passwordHash: null,
      });

      const envelope = await sealedWith(await service.resolveBackupKey(user));

      expect(
        (await decryptBackup(envelope, "dedicated-password")).equals(payload),
      ).toBe(true);
    });

    it("drops a key wrapped under a password the user has since changed", async () => {
      // A reset link, an admin or an emergency claim changed the hash without
      // re-wrapping. A backup under the old password is a file the user cannot
      // open; better an unencrypted one until the next sign-in.
      const { user } = await keyedUser("old-password", "old-hash", {
        passwordHash: "new-hash",
      });

      expect(await service.resolveBackupKey(user)).toEqual({ status: "none" });
      const [criteria, cleared] = usersRepo.update.mock.calls[0];
      // Only if the stale wrap is still the one there: a sign-in that has just
      // written a fresh key must not be wiped.
      expect(criteria).toEqual({
        id: userId,
        backupKeyWrap: user.backupKeyWrap,
      });
      expect(cleared).toEqual({
        backupEncryptionEnabled: false,
        backupPasswordEnc: null,
        backupKeyEnc: null,
        backupKeyWrap: null,
        backupKeyPasswordRef: null,
      });
    });

    it("reports 'unrecoverable' when the stored key cannot be decrypted", async () => {
      const { user } = await keyedUser("hunter2hunter2", hash);
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad key");
      });

      // Distinct from "none": the caller must refuse rather than silently
      // writing plaintext where it used to write ciphertext.
      expect(await service.resolveBackupKey(user)).toEqual({
        status: "unrecoverable",
      });
    });

    it("reports 'unrecoverable' for a malformed stored key", async () => {
      const { user } = await keyedUser("hunter2hunter2", hash, {
        backupKeyWrap: "not base64 at all!",
      });

      expect(await service.resolveBackupKey(user)).toEqual({
        status: "unrecoverable",
      });
    });

    describe("a row still holding the retired password copy", () => {
      it("still gets an encrypted backup, opened by the same password, and is converted", async () => {
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        const user = makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:hunter2hunter2",
        });

        const resolution = await service.resolveBackupKey(user);

        // Behaves as before for the user: encrypted, and their password opens it.
        const envelope = await sealedWith(resolution);
        expect(
          (await decryptBackup(envelope, "hunter2hunter2")).equals(payload),
        ).toBe(true);
        // ...and the recoverable copy is gone, conditional on it being the one read.
        const [criteria, stored] = onlyUpdate();
        expect(criteria).toEqual({
          id: userId,
          passwordHash: hash,
          backupPasswordEnc: "enc:hunter2hunter2",
        });
        await expectNoRecoverablePassword(stored, "hunter2hunter2");
      });

      it("converts an OIDC dedicated password without a login-hash check", async () => {
        const user = makeUser({
          authProvider: "oidc",
          passwordHash: null,
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:dedicated-password",
        });

        const envelope = await sealedWith(await service.resolveBackupKey(user));

        expect(bcrypt.compare).not.toHaveBeenCalled();
        expect(
          (await decryptBackup(envelope, "dedicated-password")).equals(payload),
        ).toBe(true);
        const [criteria, stored] = onlyUpdate();
        expect(criteria).toEqual({
          id: userId,
          backupPasswordEnc: "enc:dedicated-password",
        });
        expect(stored.backupKeyPasswordRef).toBeNull();
        await expectNoRecoverablePassword(stored, "dedicated-password");
      });

      it("still encrypts this backup when the conversion write fails", async () => {
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        usersRepo.update.mockRejectedValue(new Error("db down"));

        const resolution = await service.resolveBackupKey(
          makeUser({
            backupEncryptionEnabled: true,
            backupPasswordEnc: "enc:hunter2hunter2",
          }),
        );

        const envelope = await sealedWith(resolution);
        expect(
          (await decryptBackup(envelope, "hunter2hunter2")).equals(payload),
        ).toBe(true);
      });

      it("drops a copy that no longer matches the login password", async () => {
        (bcrypt.compare as jest.Mock).mockResolvedValue(false);

        const result = await service.resolveBackupKey(
          makeUser({
            backupEncryptionEnabled: true,
            backupPasswordEnc: "enc:old-password",
          }),
        );

        expect(result).toEqual({ status: "none" });
        expect(usersRepo.update).toHaveBeenCalledWith(
          { id: userId, backupPasswordEnc: "enc:old-password" },
          expect.objectContaining({
            backupEncryptionEnabled: false,
            backupPasswordEnc: null,
          }),
        );
      });

      it("reports 'unrecoverable' when the copy cannot be decrypted", async () => {
        encryption.decrypt.mockImplementation(() => {
          throw new Error("bad key");
        });

        expect(
          await service.resolveBackupKey(
            makeUser({
              backupEncryptionEnabled: true,
              backupPasswordEnc: "enc:unreadable",
            }),
          ),
        ).toEqual({ status: "unrecoverable" });
      });

      it("clears a copy left beside a current key", async () => {
        // A previous release's sign-in during a rolling deploy writes the copy
        // again; the key is current, so the copy is simply removed.
        const { user } = await keyedUser("hunter2hunter2", hash, {
          backupPasswordEnc: "enc:hunter2hunter2",
        });

        expect((await service.resolveBackupKey(user)).status).toBe("key");
        expect(usersRepo.update).toHaveBeenCalledWith(
          { id: userId, backupPasswordEnc: "enc:hunter2hunter2" },
          { backupPasswordEnc: null },
        );
      });
    });
  });

  describe("setBackupPasswordForOidcUser", () => {
    function oidcUser(overrides: Partial<User> = {}) {
      return makeUser({
        authProvider: "oidc",
        passwordHash: null,
        ...overrides,
      });
    }

    it("wraps a key under the dedicated password and turns encryption on", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());

      await service.setBackupPasswordForOidcUser(userId, "a-strong-password");

      // Targeted update of the owned columns, never a full-entity save.
      expect(usersRepo.save).not.toHaveBeenCalled();
      const [criteria, stored] = onlyUpdate();
      expect(criteria).toEqual({ id: userId });
      expect(stored.backupKeyPasswordRef).toBeNull();
      await expectNoRecoverablePassword(stored, "a-strong-password");
    });

    it("replaces an existing dedicated password, clearing a retired copy", async () => {
      usersRepo.findOne.mockResolvedValue(
        oidcUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:old-backup-password",
        }),
      );

      await service.setBackupPasswordForOidcUser(userId, "new-backup-password");

      const [, stored] = onlyUpdate();
      await expectNoRecoverablePassword(stored, "new-backup-password");
    });

    it("refuses a local-auth account", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());

      // Their key is re-made at the next login, so accepting this would store
      // something that is about to be overwritten.
      await expect(
        service.setBackupPasswordForOidcUser(userId, "a-strong-password"),
      ).rejects.toThrow(BadRequestException);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("rejects a password shorter than the minimum", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());

      await expect(
        service.setBackupPasswordForOidcUser(userId, "short"),
      ).rejects.toThrow(/at least 12/);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("rejects a breached password", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());
      passwordBreach.isBreached.mockResolvedValue(true);

      await expect(
        service.setBackupPasswordForOidcUser(userId, "correct horse battery"),
      ).rejects.toThrow(/data breach/);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it("refuses when the server has no encryption key", async () => {
      usersRepo.findOne.mockResolvedValue(oidcUser());
      encryption.isConfigured.mockReturnValue(false);

      await expect(
        service.setBackupPasswordForOidcUser(userId, "a-strong-password"),
      ).rejects.toThrow(/ENCRYPTION_KEY/);
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("disableForOidcUser", () => {
    it("clears the stored key and any retired copy", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          authProvider: "oidc",
          passwordHash: null,
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:dedicated",
        }),
      );

      await service.disableForOidcUser(userId);

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupEncryptionEnabled: false,
          backupPasswordEnc: null,
          backupKeyEnc: null,
          backupKeyWrap: null,
          backupKeyPasswordRef: null,
        },
      );
    });

    it("refuses a local-auth account", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ backupEncryptionEnabled: true }),
      );

      // "Disabled" would be a lie: the next sign-in wraps a key again and
      // turns it straight back on.
      await expect(service.disableForOidcUser(userId)).rejects.toThrow(
        BadRequestException,
      );
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("forgetBackupKey", () => {
    it("clears the stored key", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ backupEncryptionEnabled: true, backupKeyEnc: "enc:k" }),
      );

      await service.forgetBackupKey(userId);

      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).toHaveBeenCalledWith(
        { id: userId },
        {
          backupEncryptionEnabled: false,
          backupPasswordEnc: null,
          backupKeyEnc: null,
          backupKeyWrap: null,
          backupKeyPasswordRef: null,
        },
      );
    });

    it("is a no-op for a user that no longer exists", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.forgetBackupKey(userId)).resolves.toBeUndefined();
      expect(usersRepo.save).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });
});
