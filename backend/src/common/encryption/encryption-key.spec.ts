import { Logger } from "@nestjs/common";
import {
  assertEncryptionKeyConfigured,
  ENCRYPTION_KEY_ENV,
  envReaderFromRecord,
  LEGACY_ENCRYPTION_KEY_ENV,
  logEncryptionKeySource,
  MIN_ENCRYPTION_KEY_LENGTH,
  resolveEncryptionKey,
} from "./encryption-key";

const CURRENT = "c".repeat(MIN_ENCRYPTION_KEY_LENGTH);
const LEGACY = "l".repeat(MIN_ENCRYPTION_KEY_LENGTH);

const read = (env: Record<string, string | undefined>) =>
  envReaderFromRecord(env);

describe("resolveEncryptionKey", () => {
  it("reads ENCRYPTION_KEY", () => {
    expect(
      resolveEncryptionKey(read({ [ENCRYPTION_KEY_ENV]: CURRENT })),
    ).toEqual({ key: CURRENT, source: ENCRYPTION_KEY_ENV });
  });

  it("still reads AI_ENCRYPTION_KEY, so an existing deployment upgrades unchanged", () => {
    // Every column encrypted under the old name is AES-GCM ciphertext that only
    // that key opens; dropping the name would strand provider keys,
    // emergency-access credentials and the stored backup password at once.
    expect(
      resolveEncryptionKey(read({ [LEGACY_ENCRYPTION_KEY_ENV]: LEGACY })),
    ).toEqual({ key: LEGACY, source: LEGACY_ENCRYPTION_KEY_ENV });
  });

  it("prefers the legacy name when both are set", () => {
    // Deliberately not the other way round: a deployment that has both has
    // ciphertext written under the legacy key, and preferring the new name would
    // open none of it. New deployments set only ENCRYPTION_KEY.
    expect(
      resolveEncryptionKey(
        read({
          [ENCRYPTION_KEY_ENV]: CURRENT,
          [LEGACY_ENCRYPTION_KEY_ENV]: LEGACY,
        }),
      ),
    ).toEqual({ key: LEGACY, source: LEGACY_ENCRYPTION_KEY_ENV });
  });

  it("treats a too-short value as absent under either name", () => {
    // "Misconfigured" reaching the startup check as "unset" is the point: the
    // alternative is booting a server that cannot decrypt what it writes.
    const short = "x".repeat(MIN_ENCRYPTION_KEY_LENGTH - 1);
    expect(
      resolveEncryptionKey(
        read({
          [ENCRYPTION_KEY_ENV]: short,
          [LEGACY_ENCRYPTION_KEY_ENV]: short,
        }),
      ),
    ).toBeNull();
  });

  it("falls through a too-short legacy value to a usable current one", () => {
    expect(
      resolveEncryptionKey(
        read({
          [ENCRYPTION_KEY_ENV]: CURRENT,
          [LEGACY_ENCRYPTION_KEY_ENV]: "short",
        }),
      ),
    ).toEqual({ key: CURRENT, source: ENCRYPTION_KEY_ENV });
  });

  it("is null when neither name is set", () => {
    expect(resolveEncryptionKey(read({}))).toBeNull();
  });
});

describe("assertEncryptionKeyConfigured", () => {
  it("refuses a deployment with no key", () => {
    // The refusal is what makes the variable mandatory. Optional is the state
    // that produced issue #1269.
    expect(() => assertEncryptionKeyConfigured(read({}))).toThrow(
      new RegExp(ENCRYPTION_KEY_ENV),
    );
  });

  it("names the generator and the legacy variable in the refusal", () => {
    // An operator meeting this in a crash-looping container needs the fix in the
    // message, not a documentation search.
    let message = "";
    try {
      assertEncryptionKeyConfigured(read({}));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("openssl rand -hex 32");
    expect(message).toContain(LEGACY_ENCRYPTION_KEY_ENV);
    expect(message).toContain(String(MIN_ENCRYPTION_KEY_LENGTH));
  });

  it("passes under either name", () => {
    expect(() =>
      assertEncryptionKeyConfigured(read({ [ENCRYPTION_KEY_ENV]: CURRENT })),
    ).not.toThrow();
    expect(() =>
      assertEncryptionKeyConfigured(
        read({ [LEGACY_ENCRYPTION_KEY_ENV]: LEGACY }),
      ),
    ).not.toThrow();
  });
});

describe("logEncryptionKeySource", () => {
  it("warns once when the key came from the deprecated name", () => {
    const logger = { warn: jest.fn() } as unknown as Logger;
    logEncryptionKeySource(
      { key: LEGACY, source: LEGACY_ENCRYPTION_KEY_ENV },
      logger,
    );
    // A rename nobody is told about never happens.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(ENCRYPTION_KEY_ENV),
    );
  });

  it("says nothing when the key came from the current name", () => {
    const logger = { warn: jest.fn() } as unknown as Logger;
    logEncryptionKeySource(
      { key: CURRENT, source: ENCRYPTION_KEY_ENV },
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
