import { PasswordBreachService } from "./password-breach.service";
import * as crypto from "crypto";

describe("PasswordBreachService", () => {
  let service: PasswordBreachService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new PasswordBreachService();
    fetchSpy = jest.spyOn(global, "fetch");
    jest
      .spyOn((service as any).logger, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // SHA-1 is used here only to replicate HIBP's k-Anonymity API format
  // inside unit-test fixtures. This is not a password-storage hash.
  function sha1Suffix(password: string): string {
    return (
      crypto
        .createHash("sha1")
        // Reported on the `.update(password)` line; the alert belongs dismissed
        // on the Security tab as "used in tests". The annotation covers only
        // the next line.
        // codeql[js/insufficient-password-hash]
        .update(password)
        .digest("hex")
        .toUpperCase()
        .substring(5)
    );
  }

  it("returns true when password is found in breach data", async () => {
    const suffix = sha1Suffix("password123");
    const responseBody = `${suffix}:42\nABCDEF1234567890ABCDEFGHIJKLMNOPQR:5`;

    fetchSpy.mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(responseBody),
    });

    const result = await service.isBreached("password123");

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://api.pwnedpasswords.com/range/"),
      expect.objectContaining({
        headers: { "User-Agent": "Monize-PasswordCheck" },
      }),
    );
  });

  it("returns false when password is not found in breach data", async () => {
    const responseBody =
      "0000000000000000000000000000000AAAA:1\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:2";

    fetchSpy.mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(responseBody),
    });

    const result = await service.isBreached("my-unique-secure-password-xyz!");

    expect(result).toBe(false);
  });

  it("fails open when API returns non-OK status", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
    });

    const result = await service.isBreached("password123");

    expect(result).toBe(false);
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HIBP API returned status 503"),
    );
  });

  it("fails open when fetch throws a network error", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const result = await service.isBreached("password123");

    expect(result).toBe(false);
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HIBP API request failed"),
    );
  });
});
