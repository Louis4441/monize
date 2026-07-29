import { rc4, rc4InPlace } from "./rc4";

describe("rc4", () => {
  // Test vectors from RFC 6229 / the original RC4 publication.
  const vectors: ReadonlyArray<[string, string, string]> = [
    ["Key", "Plaintext", "bbf316e8d940af0ad3"],
    ["Wiki", "pedia", "1021bf0420"],
    ["Secret", "Attack at dawn", "45a01f645fc35b383552544b9bf5"],
  ];

  it.each(vectors)("encrypts with key %s", (key, plaintext, expected) => {
    const result = rc4(Buffer.from(key), Buffer.from(plaintext));

    expect(result.toString("hex")).toBe(expected);
  });

  it("is symmetric", () => {
    const key = Buffer.from("Key");
    const plaintext = Buffer.from("Plaintext");

    const roundTripped = rc4(key, rc4(key, plaintext));

    expect(roundTripped.toString()).toBe("Plaintext");
  });

  it("leaves the input untouched", () => {
    const data = Buffer.from("Plaintext");

    rc4(Buffer.from("Key"), data);

    expect(data.toString()).toBe("Plaintext");
  });

  it("repeats short keys across the key schedule", () => {
    // A one-byte key must still produce a full 256-entry state, so encrypting
    // anything longer than the key works.
    const result = rc4(Buffer.from([0x01]), Buffer.alloc(16));

    expect(result).toHaveLength(16);
    expect(result.some((byte) => byte !== 0)).toBe(true);
  });

  it("handles empty input", () => {
    expect(rc4(Buffer.from("Key"), Buffer.alloc(0))).toHaveLength(0);
  });
});

describe("rc4InPlace", () => {
  it("mutates and returns the same buffer", () => {
    const data = Buffer.from("Plaintext");

    const result = rc4InPlace(Buffer.from("Key"), data);

    expect(result).toBe(data);
    expect(data.toString("hex")).toBe("bbf316e8d940af0ad3");
  });

  it("decrypts a subarray view without touching the rest of the buffer", () => {
    const page = Buffer.alloc(32, 0xaa);
    const view = page.subarray(8, 16);

    rc4InPlace(Buffer.from("Key"), view);

    expect(page.subarray(0, 8).every((byte) => byte === 0xaa)).toBe(true);
    expect(page.subarray(16).every((byte) => byte === 0xaa)).toBe(true);
    expect(page.subarray(8, 16).every((byte) => byte === 0xaa)).toBe(false);
  });
});
