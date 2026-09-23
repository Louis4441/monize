import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { BackupEncryptionService } from "./backup-encryption.service";
import { User } from "../users/entities/user.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { PasswordBreachService } from "../auth/password-breach.service";
import { ConfigService } from "@nestjs/config";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createKeyWrappedEncryptStream,
  WrappedBackupKey,
} from "./backup-key-wrap";
import { decryptBackup } from "./backup-crypto.util";

// Split out of backup-encryption.service.spec.ts to keep both files under the
// repository line ceiling.

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

/**
 * The defect issue #1269 was reported from, held against the real
 * `EncryptionService` rather than a double.
 *
 * Every test above provides a mock whose `isConfigured()` returns true, so none
 * of them can see what actually broke: the key was `AI_ENCRYPTION_KEY`, an
 * optional variable documented as being for cloud AI providers, and on a
 * deployment that configured none the capture returned early every time. The
 * suite stayed green while automatic backups were written in plaintext.
 *
 * Both variable names are exercised, because both are live: a new deployment
 * sets `ENCRYPTION_KEY`, and one that predates the rename keeps its
 * `AI_ENCRYPTION_KEY` and must go on encrypting without re-keying a column.
 */
describe.each([
  ["ENCRYPTION_KEY", "e".repeat(40)],
  ["AI_ENCRYPTION_KEY", "a".repeat(40)],
])("BackupEncryptionService keyed by %s", (envVar, keyValue) => {
  const userId = "user-1";
  let service: BackupEncryptionService;
  let usersRepo: Record<string, jest.Mock>;
  let encryption: EncryptionService;

  const baseUser = {
    id: userId,
    authProvider: "local",
    passwordHash: "bcrypt-hash",
    backupEncryptionEnabled: false,
    backupPasswordEnc: null,
    backupKeyEnc: null,
    backupKeyWrap: null,
    backupKeyPasswordRef: null,
  } as User;

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const scopedDataSource = createScopedDbMocks([[User, usersRepo as never]])
      .dataSource as unknown as DataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: DataSource, useValue: scopedDataSource },
        BackupEncryptionService,
        // The real service, over an environment holding only this one variable.
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: string) =>
              key === envVar ? keyValue : (fallback ?? ""),
            ),
          },
        },
        {
          provide: PasswordBreachService,
          useValue: { isBreached: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    service = module.get(BackupEncryptionService);
    encryption = module.get(EncryptionService);
  });

  it("wraps a key at sign-in that the cron can use and the password opens, with no password stored", async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);

    await service.rewrapBackupKey(userId, "hunter2hunter2", "bcrypt-hash");

    expect(usersRepo.update).toHaveBeenCalledTimes(1);
    const stored = usersRepo.update.mock.calls[0][1] as StoredKeyColumns;
    expect(stored.backupEncryptionEnabled).toBe(true);
    expect(stored.backupPasswordEnc).toBeNull();
    // What the server can open with its own key is a random data key, not the
    // password -- the property a database dump plus the environment tests.
    expect(encryption.decrypt(stored.backupKeyEnc)).not.toBe("hunter2hunter2");

    const resolution = await service.resolveBackupKey({
      ...baseUser,
      ...stored,
    } as User);
    expect(resolution.status).toBe("key");
    if (resolution.status !== "key") return;
    const payload = Buffer.from("payload");
    const envelope = await sealUnder(resolution.key, payload);
    expect(
      (await decryptBackup(envelope, "hunter2hunter2")).equals(payload),
    ).toBe(true);
  });

  it("reports encryption as available in the status the screen renders", async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);

    expect(await service.getStatus(userId)).toMatchObject({ available: true });
  });
});

describe("BackupEncryptionService transactions", () => {
  let service: BackupEncryptionService;
  let usersRepo: Record<string, jest.Mock>;
  let scopedDataSource: { transaction: jest.Mock };
  const userId = "user-1";

  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: userId,
      authProvider: "local",
      passwordHash: "bcrypt-hash",
      backupEncryptionEnabled: false,
      backupPasswordEnc: null,
      backupKeyEnc: null,
      backupKeyWrap: null,
      backupKeyPasswordRef: null,
      ...overrides,
    } as User;
  }

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    scopedDataSource = createScopedDbMocks([[User, usersRepo as never]])
      .dataSource as unknown as { transaction: jest.Mock };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: DataSource, useValue: scopedDataSource },
        BackupEncryptionService,
        {
          provide: EncryptionService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(true),
            encrypt: jest.fn((s: string) => `enc:${s}`),
            decrypt: jest.fn((s: string) => s.replace(/^enc:/, "")),
          },
        },
        {
          provide: PasswordBreachService,
          useValue: { isBreached: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();
    service = module.get(BackupEncryptionService);
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * Each of these methods used to read the users row in one transaction and
   * write it back in another, which is the read-modify-write the project's
   * transaction rule exists to forbid: between the two, any concurrent change
   * to the row was lost. `rewrapBackupKey` is deliberately not here: its read
   * is only the skip, and its guard is the `password_hash` in the update's
   * `WHERE` (asserted above).
   */
  describe("read and write share one transaction", () => {
    it.each([
      [
        "setBackupPasswordForOidcUser",
        () =>
          service.setBackupPasswordForOidcUser(userId, "long-good-password"),
        () => makeUser({ authProvider: "oidc", passwordHash: null }),
      ],
      [
        "disableForOidcUser",
        () => service.disableForOidcUser(userId),
        () =>
          makeUser({
            authProvider: "oidc",
            passwordHash: null,
            backupEncryptionEnabled: true,
          }),
      ],
      [
        "enableWithLoginPassword",
        () => service.enableWithLoginPassword(userId, "hunter2hunter2"),
        () => makeUser(),
      ],
      [
        "forgetBackupKey",
        () => service.forgetBackupKey(userId),
        () => makeUser({ backupEncryptionEnabled: true }),
      ],
    ])("%s", async (_name, run, user) => {
      usersRepo.findOne.mockResolvedValue(user());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      scopedDataSource.transaction.mockClear();

      await run();

      // One transaction, so the checks above the write ran against the state
      // the write lands on. Two would mean the row could change in between.
      expect(scopedDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(usersRepo.update).toHaveBeenCalledTimes(1);
      expect(usersRepo.save).not.toHaveBeenCalled();
    });
  });
});
