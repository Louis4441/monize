import { ConfigService } from "@nestjs/config";
import {
  BACKUP_PASSWORD_KEY_PURPOSE,
  BackupPasswordCipher,
} from "./backup-password-cipher";
import { derivePurposeKey, encrypt } from "../auth/crypto.util";

const AI_KEY = "a".repeat(32);
const JWT_SECRET = "j".repeat(48);

function cipherWith(env: Record<string, string>): BackupPasswordCipher {
  const config = {
    get: jest.fn(
      (key: string, fallback?: string) => env[key] ?? fallback ?? undefined,
    ),
  } as unknown as ConfigService;
  return new BackupPasswordCipher(config);
}

describe("BackupPasswordCipher", () => {
  /**
   * The regression the whole class exists for (issue #1269). `AI_ENCRYPTION_KEY`
   * is optional -- commented out in `.env.example`, `${AI_ENCRYPTION_KEY:-}` in
   * the compose files -- and while it was the only key, a deployment that never
   * configured an AI provider stored no backup password at all and wrote every
   * automatic backup in plaintext.
   */
  it("is configured from JWT_SECRET alone, with no AI_ENCRYPTION_KEY", () => {
    const cipher = cipherWith({ JWT_SECRET });

    expect(cipher.isConfigured()).toBe(true);
    expect(cipher.decrypt(cipher.encrypt("hunter2hunter2"))).toBe(
      "hunter2hunter2",
    );
  });

  it("derives its fallback key from JWT_SECRET under its own purpose", () => {
    const cipher = cipherWith({ JWT_SECRET });

    // Domain separation is what makes reusing the session-signing secret safe:
    // the stored password must open under the purpose-derived key and not under
    // the raw secret.
    const derived = derivePurposeKey(JWT_SECRET, BACKUP_PASSWORD_KEY_PURPOSE);
    expect(cipher.decrypt(encrypt("hunter2hunter2", derived))).toBe(
      "hunter2hunter2",
    );
    expect(() =>
      cipher.decrypt(encrypt("hunter2hunter2", JWT_SECRET)),
    ).toThrow();
  });

  it("prefers AI_ENCRYPTION_KEY when one is configured", () => {
    const cipher = cipherWith({ AI_ENCRYPTION_KEY: AI_KEY, JWT_SECRET });

    // An install that already separated this key keeps that separation, and its
    // existing rows keep being written under the key that wrote them.
    const written = cipher.encrypt("hunter2hunter2");
    expect(cipherWith({ AI_ENCRYPTION_KEY: AI_KEY }).decrypt(written)).toBe(
      "hunter2hunter2",
    );
  });

  it("reads a row written under either key", () => {
    const aiOnly = cipherWith({ AI_ENCRYPTION_KEY: AI_KEY });
    const jwtOnly = cipherWith({ JWT_SECRET });
    const both = cipherWith({ AI_ENCRYPTION_KEY: AI_KEY, JWT_SECRET });

    // Adding or removing the AI key is an ordinary configuration change, and it
    // must not strand the copies already stored under the other one.
    expect(both.decrypt(aiOnly.encrypt("from-ai-key"))).toBe("from-ai-key");
    expect(both.decrypt(jwtOnly.encrypt("from-jwt-key"))).toBe("from-jwt-key");
  });

  it("ignores a key too short to be one", () => {
    // Startup enforces 32 characters on JWT_SECRET; anything shorter is
    // misconfiguration, and silently deriving from it would encrypt under a key
    // the running server rejects everywhere else.
    const cipher = cipherWith({
      AI_ENCRYPTION_KEY: "short",
      JWT_SECRET: "also-short",
    });

    expect(cipher.isConfigured()).toBe(false);
    expect(() => cipher.encrypt("hunter2hunter2")).toThrow(/JWT_SECRET/);
    expect(() => cipher.decrypt("anything")).toThrow(/JWT_SECRET/);
  });

  it("throws rather than returning plausible bytes for an unopenable row", () => {
    // AES-GCM authenticates, which is what makes trying more than one key sound.
    const foreign = encrypt("hunter2hunter2", "z".repeat(32));

    expect(() => cipherWith({ JWT_SECRET }).decrypt(foreign)).toThrow();
  });
});
