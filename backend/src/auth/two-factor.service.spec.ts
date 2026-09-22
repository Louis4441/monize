import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import bcrypt from "bcryptjs";
import * as otplib from "otplib";
import {
  TwoFactorService,
  TOTP_CLAIM_PURPOSE,
  TWO_FACTOR_TOKEN_SCOPE,
  TWO_FACTOR_USER_SCOPE,
} from "./two-factor.service";
import { TokenService } from "./token.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { encrypt, derivePurposeKey } from "./crypto.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";
import {
  authAttemptCounterProvider,
  createAuthAttemptCounterMock,
  type AuthAttemptCounterMock,
} from "../test-helpers/auth-attempt-counter-testing";
import {
  createSingleUseTokenMock,
  singleUseKey,
  singleUseTokenProvider,
  type SingleUseTokenMock,
} from "../test-helpers/single-use-token-testing";
import { hashToken } from "./crypto.util";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const TEST_JWT_SECRET = "test-jwt-secret-minimum-32-chars-long";
const TEST_TOTP_KEY = derivePurposeKey(TEST_JWT_SECRET, "totp-encryption");

jest.mock("otplib", () => ({
  verifySync: jest.fn(),
  generateSecret: jest.fn().mockReturnValue("TESTSECRET"),
  generateURI: jest
    .fn()
    .mockReturnValue(
      "otpauth://totp/Monize:test@example.com?secret=TESTSECRET&issuer=Monize",
    ),
}));

jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mockqrcode"),
}));

describe("TwoFactorService", () => {
  let service: TwoFactorService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let preferencesRow: UserPreferenceRepoMock;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let jwtService: Record<string, jest.Mock>;
  let configService: { get: jest.Mock };
  let dataSource: Record<string, jest.Mock>;
  let tokenService: Record<string, jest.Mock>;
  let attemptCounters: AuthAttemptCounterMock;
  let singleUseTokens: SingleUseTokenMock;

  const mockUser: Partial<User> = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "user",
    isActive: true,
    twoFactorSecret: null,
    pendingTwoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    lastLogin: null,
    oidcSubject: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    backupCodes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      }),
    },
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
      create: jest.fn().mockImplementation((dto) => dto),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
        getMany: jest.fn().mockResolvedValue([]),
      }),
    };

    // Behaves like the row: enabling and disabling 2FA now patch the one column
    // rather than saving a whole entity read moments earlier.
    preferencesRow = createUserPreferenceRepoMock(null);
    preferencesRepository = preferencesRow.repo;

    trustedDevicesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((d) => Promise.resolve(d)),
      create: jest.fn().mockImplementation((dto) => dto),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    jwtService = {
      verify: jest.fn(),
      sign: jest.fn().mockReturnValue("mock-token"),
    };

    configService = {
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue?: string) => {
          if (key === "JWT_SECRET") return TEST_JWT_SECRET;
          if (key === "FORCE_2FA") return defaultValue ?? "false";
          return defaultValue ?? undefined;
        }),
    };

    // The backup-code consumption block is now one `withScopedDb`, so the
    // former queryRunner is the transaction's EntityManager.
    const scoped = createScopedDbMocks([
      [User, usersRepository as never],
      [UserPreference, preferencesRepository as never],
      [TrustedDevice, trustedDevicesRepository as never],
    ]);
    // The block's own direct-manager calls (the locked findOne and the
    // backup-code UPDATE builder) are configured here rather than copied off
    // the previous run's manager, which would carry a stale getRepository.
    scoped.manager.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    });
    mockQueryRunner.manager = scoped.manager as never;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    tokenService = {
      generateTokenPair: jest.fn().mockResolvedValue({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
      }),
    };

    // Reset mockQueryRunner mocks
    mockQueryRunner.connect.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.startTransaction.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.commitTransaction.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.rollbackTransaction
      .mockReset()
      .mockResolvedValue(undefined);
    mockQueryRunner.release.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.manager.findOne.mockReset();
    mockQueryRunner.manager.createQueryBuilder.mockReset().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    });

    attemptCounters = createAuthAttemptCounterMock();
    singleUseTokens = createSingleUseTokenMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
        { provide: DataSource, useValue: dataSource },
        { provide: TokenService, useValue: tokenService },
        authAttemptCounterProvider(attemptCounters),
        singleUseTokenProvider(singleUseTokens),
      ],
    }).compile();

    service = module.get<TwoFactorService>(TwoFactorService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("decryptTotpSecret", () => {
    it("should decrypt with purpose-derived key", () => {
      const plainSecret = "ABCDEF123456";
      const ciphertext = encrypt(plainSecret, TEST_TOTP_KEY);

      const result = service.decryptTotpSecret(ciphertext);

      expect(result.secret).toBe(plainSecret);
      expect(result.needsReEncrypt).toBe(false);
    });

    it("should fall back to legacy raw JWT secret and flag for re-encryption", () => {
      const plainSecret = "LEGACYSECRET";
      // Encrypt with the raw jwtSecret (legacy behavior)
      const ciphertext = encrypt(plainSecret, TEST_JWT_SECRET);

      const result = service.decryptTotpSecret(ciphertext);

      expect(result.secret).toBe(plainSecret);
      expect(result.needsReEncrypt).toBe(true);
    });
  });

  describe("reEncryptTotpSecret", () => {
    it("should encrypt with purpose-derived key", () => {
      const plainSecret = "MYSECRET";
      const ciphertext = service.reEncryptTotpSecret(plainSecret);

      // Should be decryptable with the purpose-derived key (no re-encrypt needed)
      const result = service.decryptTotpSecret(ciphertext);
      expect(result.secret).toBe(plainSecret);
      expect(result.needsReEncrypt).toBe(false);
    });
  });

  describe("verify2FA", () => {
    const tempToken = "temp-2fa-token";
    const code = "123456";

    let userWith2FA: Partial<User>;

    beforeEach(() => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      userWith2FA = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      };
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({ ...userWith2FA });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
    });

    it("should verify a valid TOTP code and return tokens", async () => {
      const result = await service.verify2FA(tempToken, code);

      expect(result.accessToken).toBe("mock-access-token");
      expect(result.refreshToken).toBe("mock-refresh-token");
      expect(result.user).toBeDefined();
      expect(result.trustedDeviceRef).toBeUndefined();
    });

    it("should create a trusted device when rememberDevice is true", async () => {
      trustedDevicesRepository.save.mockResolvedValue({});
      trustedDevicesRepository.create.mockReturnValue({});

      const result = await service.verify2FA(
        tempToken,
        code,
        true,
        "Mozilla/5.0",
        "127.0.0.1",
      );

      expect(result.trustedDeviceRef).toBeDefined();
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("should throw on invalid or expired token", async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error("expired");
      });

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw on invalid token type", async () => {
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "access",
      });

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw when user not found or no 2FA secret", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw on invalid TOTP code", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should reject a replayed TOTP code", async () => {
      // First verification succeeds
      await service.verify2FA(tempToken, code);

      // Reset mocks for second call
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...userWith2FA,
        twoFactorSecret: encrypt("TOTP_SECRET", TEST_TOTP_KEY),
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      // Second call with same code should fail (replay rejection)
      await expect(
        service.verify2FA("another-temp-token", code),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should re-encrypt secret when using legacy key", async () => {
      // Encrypt with raw JWT secret (legacy)
      const legacyCiphertext = encrypt("TOTP_SECRET", TEST_JWT_SECRET);
      const legacyUser = {
        ...userWith2FA,
        twoFactorSecret: legacyCiphertext,
      };
      usersRepository.findOne.mockResolvedValue({ ...legacyUser });

      await service.verify2FA(tempToken, code);

      // Should have saved the user with re-encrypted secret
      expect(usersRepository.save).toHaveBeenCalled();
      const savedUser = usersRepository.save.mock.calls[0][0];
      // The secret should now be decryptable with the purpose-derived key
      const result = service.decryptTotpSecret(savedUser.twoFactorSecret);
      expect(result.secret).toBe("TOTP_SECRET");
      expect(result.needsReEncrypt).toBe(false);
    });

    it("should block after too many per-token attempts", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // Exhaust per-token attempts (MAX_2FA_ATTEMPTS = 3)
      for (let i = 0; i < 3; i++) {
        await expect(service.verify2FA(tempToken, "wrong1")).rejects.toThrow(
          UnauthorizedException,
        );
      }

      // Next attempt should be blocked even before verification
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        "Too many verification attempts. Please log in again.",
      );
    });

    it("should block after too many per-user attempts", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // Exhaust per-user attempts (MAX_USER_2FA_ATTEMPTS = 10)
      for (let i = 0; i < 10; i++) {
        await expect(
          service.verify2FA(`temp-token-${i}`, "wrong1"),
        ).rejects.toThrow(UnauthorizedException);
      }

      // Next attempt with new token should still be blocked (per-user limit)
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      await expect(service.verify2FA("fresh-token", code)).rejects.toThrow(
        "Too many verification attempts. Your account has been temporarily locked.",
      );
    });

    it("should verify backup codes for non-6-digit format", async () => {
      const hashedCode = await bcrypt.hash("abcd-ef01", 10);
      const userWithBackup = {
        ...userWith2FA,
        backupCodes: JSON.stringify([hashedCode]),
      };
      usersRepository.findOne.mockResolvedValue({ ...userWithBackup });

      // Mock QueryRunner for backup code verification
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...userWithBackup,
        backupCodes: JSON.stringify([hashedCode]),
      });

      const result = await service.verify2FA(tempToken, "abcd-ef01");

      expect(result.accessToken).toBe("mock-access-token");
    });
  });

  describe("setup2FA", () => {
    it("should generate a secret and QR code for a local user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      jest.spyOn(bcrypt, "compare").mockResolvedValueOnce(true as never);

      const result = await service.setup2FA("user-1", "correct-password");

      expect(result.secret).toBe("TESTSECRET");
      expect(result.qrCodeDataUrl).toBe("data:image/png;base64,mockqrcode");
      expect(result.otpauthUrl).toContain("otpauth://totp/");
      expect(usersRepository.save).toHaveBeenCalled();
    });

    it("should throw NotFoundException for unknown user", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.setup2FA("nonexistent", "pw")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should reject SSO (OIDC) users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
      });

      await expect(service.setup2FA("user-1", "pw")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject incorrect current password", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      jest.spyOn(bcrypt, "compare").mockResolvedValueOnce(false as never);

      await expect(
        service.setup2FA("user-1", "wrong-password"),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("confirmSetup2FA", () => {
    it("should promote pending secret to active on valid code", async () => {
      const pendingSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: pendingSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRow.seed(null);

      const result = await service.confirmSetup2FA("user-1", "123456");

      expect(result.message).toContain("enabled successfully");
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.twoFactorSecret).toBe(pendingSecret);
      expect(savedUser.pendingTwoFactorSecret).toBeNull();
      // No preferences row existed, so one is materialized and then flagged.
      expect(preferencesRow.insertAttempts()).toHaveLength(1);
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(true);
    });

    it("should update existing preferences", async () => {
      const pendingSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: pendingSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRow.seed({
        userId: "user-1",
        twoFactorEnabled: false,
        theme: "nord",
      });

      await service.confirmSetup2FA("user-1", "123456");

      expect(preferencesRow.row()!.twoFactorEnabled).toBe(true);
      // A security flag is the last thing that should be written by overwriting
      // the whole row: only this column moves.
      expect(Object.keys(preferencesRow.patches()[0])).toEqual([
        "twoFactorEnabled",
      ]);
      expect(preferencesRow.row()!.theme).toBe("nord");
    });

    it("should throw when no pending secret", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(service.confirmSetup2FA("user-1", "123456")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw on invalid code", async () => {
      const pendingSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: pendingSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.confirmSetup2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("disable2FA", () => {
    it("should disable 2FA and clear trusted devices", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRow.seed({ userId: "user-1", twoFactorEnabled: true });

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.twoFactorSecret).toBeNull();
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(false);
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("should throw ForbiddenException when FORCE_2FA is enabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          if (key === "JWT_SECRET") return TEST_JWT_SECRET;
          if (key === "FORCE_2FA") return "true";
          return defaultValue ?? undefined;
        },
      );

      // Need to recreate the service so the configService mock takes effect in disable2FA
      // Since FORCE_2FA is checked at call time (not constructor), we just call it
      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should throw when 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw on invalid verification code", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.disable2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("clears the flag even when no preferences row exists yet", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRow.seed(null);

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");
      // Previously this skipped the write entirely, so a user whose preferences
      // had never materialized stayed flagged as 2FA-enabled after disabling it.
      expect(preferencesRow.row()!.twoFactorEnabled).toBe(false);
    });
  });

  describe("generateBackupCodes", () => {
    it("should generate and store hashed backup codes", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const codes = await service.generateBackupCodes("user-1", "123456");

      expect(codes).toHaveLength(12);
      codes.forEach((code) => {
        expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
      });

      const savedUser = usersRepository.save.mock.calls[0][0];
      const storedHashes = JSON.parse(savedUser.backupCodes);
      expect(storedHashes).toHaveLength(12);
    });

    it("should throw when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.generateBackupCodes("nonexistent", "123456"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw when 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(
        service.generateBackupCodes("user-1", "123456"),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw on invalid verification code", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.generateBackupCodes("user-1", "000000"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("migrateLegacyTotpSecrets", () => {
    it("should migrate users with legacy-encrypted secrets", async () => {
      // Encrypt with raw JWT secret (legacy)
      const legacyCiphertext = encrypt("MY_TOTP_SECRET", TEST_JWT_SECRET);

      usersRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: "user-1",
            twoFactorSecret: legacyCiphertext,
          },
          {
            id: "user-2",
            twoFactorSecret: encrypt("OTHER_SECRET", TEST_TOTP_KEY), // already migrated
          },
        ]),
      });

      const count = await service.migrateLegacyTotpSecrets();

      expect(count).toBe(1);
      // The user with legacy secret should have been saved
      expect(usersRepository.save).toHaveBeenCalledTimes(1);
      const savedUser = usersRepository.save.mock.calls[0][0];
      // Verify the re-encrypted secret can be decrypted with the purpose-derived key
      const result = service.decryptTotpSecret(savedUser.twoFactorSecret);
      expect(result.secret).toBe("MY_TOTP_SECRET");
      expect(result.needsReEncrypt).toBe(false);
    });

    it("should return 0 when no users need migration", async () => {
      usersRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: "user-1",
            twoFactorSecret: encrypt("SECRET", TEST_TOTP_KEY),
          },
        ]),
      });

      const count = await service.migrateLegacyTotpSecrets();

      expect(count).toBe(0);
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("should return 0 when no users have 2FA secrets", async () => {
      usersRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const count = await service.migrateLegacyTotpSecrets();

      expect(count).toBe(0);
    });
  });

  describe("validateTrustedDevice", () => {
    it("should return true for a valid, non-expired device with matching user-agent", async () => {
      const userAgent =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0";
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        userAgentHash: (service as any).hashUserAgent(userAgent),
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
        userAgent,
      );

      expect(result).toBe(true);
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("should return false when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(false);
    });

    it("should remove expired device and return false", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        expiresAt: new Date(Date.now() - 1000), // expired
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(false);
      expect(trustedDevicesRepository.remove).toHaveBeenCalled();
    });

    it("should reject when user-agent fingerprint does not match", async () => {
      const originalUA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0";
      const differentUA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Firefox/121.0";
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        userAgentHash: (service as any).hashUserAgent(originalUA),
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
        differentUA,
      );

      expect(result).toBe(false);
      // Should NOT save (rejected before updating lastUsedAt)
      expect(trustedDevicesRepository.save).not.toHaveBeenCalled();
    });

    it("should skip user-agent check when userAgent is not provided", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        userAgentHash: "some-hash",
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(true);
    });
  });

  describe("createTrustedDevice", () => {
    it("should create and save a trusted device, returning the token", async () => {
      const result = await service.createTrustedDevice(
        "user-1",
        "Mozilla/5.0 Chrome/120.0",
        "192.168.1.1",
      );

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(trustedDevicesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          ipAddress: "192.168.1.1",
        }),
      );
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("should use null for ipAddress when not provided", async () => {
      await service.createTrustedDevice("user-1", "Mozilla/5.0");

      expect(trustedDevicesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: null,
        }),
      );
    });
  });

  describe("getTrustedDevices", () => {
    it("should delete expired devices and return remaining", async () => {
      const devices = [
        { id: "d-1", deviceName: "Chrome on Linux", lastUsedAt: new Date() },
      ];
      trustedDevicesRepository.find.mockResolvedValue(devices);

      const result = await service.getTrustedDevices("user-1");

      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
        expiresAt: expect.anything(),
      });
      expect(result).toEqual(devices);
    });
  });

  describe("revokeTrustedDevice", () => {
    it("should remove the device", async () => {
      const device = { id: "device-1", userId: "user-1" };
      trustedDevicesRepository.findOne.mockResolvedValue(device);

      await service.revokeTrustedDevice("user-1", "device-1");

      expect(trustedDevicesRepository.remove).toHaveBeenCalledWith(device);
    });

    it("should throw NotFoundException when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.revokeTrustedDevice("user-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("revokeAllTrustedDevices", () => {
    it("should delete all devices for the user and return count", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 3 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(3);
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("should return 0 when no devices exist", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 0 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(0);
    });
  });

  describe("findTrustedDeviceByToken", () => {
    it("should return device id when found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
      });

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "some-token",
      );

      expect(result).toBe("device-1");
    });

    it("should return null when not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "unknown-token",
      );

      expect(result).toBeNull();
    });
  });

  describe("sanitizeUser", () => {
    it("should strip sensitive fields and add hasPassword", () => {
      const user = {
        ...mockUser,
        id: "user-1",
        email: "test@example.com",
        passwordHash: "hashed",
        twoFactorSecret: "secret",
        pendingTwoFactorSecret: "pending",
        resetToken: "token",
        resetTokenExpiry: new Date(),
        failedLoginAttempts: 3,
        lockedUntil: new Date(),
        backupCodes: "codes",
        oidcLinkPending: true,
        oidcLinkToken: "link-token",
        oidcLinkExpiresAt: new Date(),
        pendingOidcSubject: "sub",
      } as unknown as User;

      const result = service.sanitizeUser(user);

      expect(result.hasPassword).toBe(true);
      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result).not.toHaveProperty("pendingTwoFactorSecret");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("resetTokenExpiry");
      expect(result).not.toHaveProperty("failedLoginAttempts");
      expect(result).not.toHaveProperty("lockedUntil");
      expect(result).not.toHaveProperty("backupCodes");
      expect(result).not.toHaveProperty("oidcLinkPending");
      expect(result).not.toHaveProperty("oidcLinkToken");
      expect(result).not.toHaveProperty("oidcLinkExpiresAt");
      expect(result).not.toHaveProperty("pendingOidcSubject");
      expect(result).toHaveProperty("email", "test@example.com");
    });

    it("should set hasPassword to false when no password hash", () => {
      const user = {
        ...mockUser,
        passwordHash: null,
      } as unknown as User;

      const result = service.sanitizeUser(user);

      expect(result.hasPassword).toBe(false);
    });
  });

  describe("verifyBackupCode (via verify2FA)", () => {
    it("should handle concurrent backup code consumption rollback", async () => {
      const hashedCode = await bcrypt.hash("abcd-ef01", 10);
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      const userWithBackup = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify([hashedCode]),
      };

      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({ ...userWithBackup });

      // First pre-check finds the code, but the locked row has no codes
      // (concurrent consumption scenario)
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...userWithBackup,
        backupCodes: JSON.stringify(["different-hash-not-matching"]),
      });

      // The backup code won't match in the re-verify step, causing rollback
      await expect(
        service.verify2FA("temp-token", "abcd-ef01"),
      ).rejects.toThrow(UnauthorizedException);

      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("should handle error during backup code verification", async () => {
      const hashedCode = await bcrypt.hash("abcd-ef01", 10);
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      const userWithBackup = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify([hashedCode]),
      };

      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({ ...userWithBackup });

      // Simulate a database error during QueryRunner operations
      mockQueryRunner.manager.findOne.mockRejectedValue(
        new Error("DB connection lost"),
      );

      await expect(
        service.verify2FA("temp-token", "abcd-ef01"),
      ).rejects.toThrow("DB connection lost");

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("attempt counters", () => {
    const encryptedSecret = () => encrypt("TOTP_SECRET", TEST_TOTP_KEY);

    beforeEach(() => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret(),
      });
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
    });

    // The scope and key strings are the contract between replicas: two
    // processes that spell them differently enforce two separate limits.
    it("counts a failure under the documented scopes, hashing the temp token", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.verify2FA("temp-token", "000000")).rejects.toThrow(
        UnauthorizedException,
      );

      // "sliding" is the shape the `Map` entries had: each failure pushed the
      // expiry out, so a paced attacker still reaches the tenth failure that
      // locks the account. A fixed window would silently never lock it.
      expect(attemptCounters.increment).toHaveBeenCalledWith(
        TWO_FACTOR_TOKEN_SCOPE,
        hashToken("temp-token"),
        5 * 60 * 1000,
        "sliding",
      );
      expect(attemptCounters.increment).toHaveBeenCalledWith(
        TWO_FACTOR_USER_SCOPE,
        "user-1",
        5 * 60 * 1000,
        "sliding",
      );
      // The raw JWT never reaches the table.
      for (const [, key] of attemptCounters.increment.mock.calls) {
        expect(key).not.toContain("temp-token");
      }
    });

    it("clears both counters on success", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await service.verify2FA("temp-token", "123456");

      expect(attemptCounters.reset).toHaveBeenCalledWith(
        TWO_FACTOR_TOKEN_SCOPE,
        hashToken("temp-token"),
      );
      expect(attemptCounters.reset).toHaveBeenCalledWith(
        TWO_FACTOR_USER_SCOPE,
        "user-1",
      );
    });

    // The point of moving the counters onto rows: a count another replica (or
    // this one, before a restart) wrote is the count this request is refused on.
    it("refuses on a count this process never incremented", async () => {
      attemptCounters.rows.set(`${TWO_FACTOR_USER_SCOPE}\u0000user-1`, {
        count: 10,
        windowExpiresAt: new Date(Date.now() + 60_000),
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await expect(service.verify2FA("fresh-token", "123456")).rejects.toThrow(
        "Too many verification attempts. Your account has been temporarily locked.",
      );
      expect(otplib.verifySync).not.toHaveBeenCalled();
    });

    /**
     * The authenticated management endpoints check a code against the same
     * secret, so they draw from the same per-user budget. Before, they verified
     * a TOTP code with no attempt limit at all: a stolen session could guess
     * its way to disabling 2FA bounded only by the per-IP throttle, which a
     * forwarded header could reset.
     */
    describe.each([
      ["disable2FA", (code: string) => service.disable2FA("user-1", code)],
      [
        "generateBackupCodes",
        (code: string) => service.generateBackupCodes("user-1", code),
      ],
    ] as const)("%s", (_name, call) => {
      it("counts a wrong code against the per-user 2FA budget", async () => {
        (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

        await expect(call("000000")).rejects.toThrow(BadRequestException);

        expect(attemptCounters.increment).toHaveBeenCalledWith(
          TWO_FACTOR_USER_SCOPE,
          "user-1",
          5 * 60 * 1000,
          "sliding",
        );
      });

      it("refuses with 429 once the budget is spent, before checking the code", async () => {
        attemptCounters.rows.set(`${TWO_FACTOR_USER_SCOPE}\u0000user-1`, {
          count: 10,
          windowExpiresAt: new Date(Date.now() + 60_000),
        });
        (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

        const refusal = await call("123456").catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(HttpException);
        expect((refusal as HttpException).getStatus()).toBe(
          HttpStatus.TOO_MANY_REQUESTS,
        );
        expect(otplib.verifySync).not.toHaveBeenCalled();
        expect(usersRepository.save).not.toHaveBeenCalled();
      });

      it("locks the account on the failure that reaches the threshold", async () => {
        attemptCounters.rows.set(`${TWO_FACTOR_USER_SCOPE}\u0000user-1`, {
          count: 9,
          windowExpiresAt: new Date(Date.now() + 60_000),
        });
        (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

        await expect(call("000000")).rejects.toThrow(BadRequestException);

        const builder = usersRepository.createQueryBuilder.mock.results[0]
          ?.value as { set: jest.Mock };
        expect(builder.set).toHaveBeenCalledWith({
          lockedUntil: expect.any(Date),
        });
      });

      it("clears the per-user count on success", async () => {
        (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
        preferencesRow.seed({ userId: "user-1", twoFactorEnabled: true });

        await call("123456");

        expect(attemptCounters.reset).toHaveBeenCalledWith(
          TWO_FACTOR_USER_SCOPE,
          "user-1",
        );
      });
    });
  });

  describe("TOTP single-use claim", () => {
    const encryptedSecret = () => encrypt("TOTP_SECRET", TEST_TOTP_KEY);

    beforeEach(() => {
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret(),
      });
    });

    it("claims the code under the shared purpose, keyed by user and code", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await service.verify2FA("token-1", "123456");

      expect(singleUseTokens.claim).toHaveBeenCalledWith(
        TOTP_CLAIM_PURPOSE,
        "user-1:123456",
        90 * 1000,
      );
    });

    // Claiming before verification would let a guesser burn valid codes.
    it("does not claim a code that failed verification", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.verify2FA("token-1", "999999")).rejects.toThrow(
        UnauthorizedException,
      );

      expect(singleUseTokens.claim).not.toHaveBeenCalled();
    });

    // The point of the table: the first spend may have happened on a replica
    // this process has never spoken to.
    it("refuses a code another replica already spent, and counts the attempt", async () => {
      singleUseTokens.claimed.add(
        singleUseKey(TOTP_CLAIM_PURPOSE, "user-1:123456"),
      );
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await expect(service.verify2FA("token-1", "123456")).rejects.toThrow(
        "Invalid verification code",
      );

      // A replay is a failed attempt, exactly as a wrong code is.
      expect(attemptCounters.increment).toHaveBeenCalledWith(
        TWO_FACTOR_USER_SCOPE,
        "user-1",
        5 * 60 * 1000,
        "sliding",
      );
      expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
    });

    it("issues no session when the claim is lost", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await service.verify2FA("token-1", "123456");
      jest.clearAllMocks();
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret(),
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await expect(service.verify2FA("token-2", "123456")).rejects.toThrow(
        "Invalid verification code",
      );
      expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
    });
  });

  describe("verifyTotpForUser", () => {
    let encryptedSecret: string;

    beforeEach(() => {
      encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
    });

    it("returns false for non-6-digit codes", async () => {
      const result = await service.verifyTotpForUser("user-1", "abc");
      expect(result).toBe(false);
      expect(usersRepository.findOne).not.toHaveBeenCalled();
    });

    it("returns false when the user has no 2FA secret", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });
      const result = await service.verifyTotpForUser("user-1", "123456");
      expect(result).toBe(false);
    });

    it("returns false when the user is missing", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const result = await service.verifyTotpForUser("user-1", "123456");
      expect(result).toBe(false);
    });

    it("returns true for a valid code", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const result = await service.verifyTotpForUser("user-1", "123456");
      expect(result).toBe(true);
    });

    it("returns false for an invalid code without spending a claim", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const result = await service.verifyTotpForUser("user-1", "999999");
      expect(result).toBe(false);
      expect(singleUseTokens.claim).not.toHaveBeenCalled();
    });

    // One purpose and one key shape across both TOTP paths is what stops a code
    // presented at login from being replayed against a step-up endpoint.
    it("shares the login path's claim purpose and key", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await service.verifyTotpForUser("user-1", "123456");

      expect(singleUseTokens.claim).toHaveBeenCalledWith(
        TOTP_CLAIM_PURPOSE,
        "user-1:123456",
        90 * 1000,
      );
    });

    it("rejects a code that was already used in this window (replay)", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const first = await service.verifyTotpForUser("user-1", "123456");
      expect(first).toBe(true);

      const replay = await service.verifyTotpForUser("user-1", "123456");
      expect(replay).toBe(false);
    });
  });
});
