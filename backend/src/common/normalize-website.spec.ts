import { normalizeWebsite } from "./normalize-website";

describe("normalizeWebsite", () => {
  it("adds https to a bare address, so nobody has to type a scheme", () => {
    expect(normalizeWebsite("apple.com")).toBe("https://apple.com");
    expect(normalizeWebsite("www.starbucks.co.uk/menu")).toBe(
      "https://www.starbucks.co.uk/menu",
    );
  });

  it("leaves an explicit http address alone", () => {
    // Someone who typed http:// meant it, usually because the host serves
    // nothing else; upgrading them produces a link that fails to connect.
    expect(normalizeWebsite("http://example.com")).toBe("http://example.com");
  });

  it("keeps an address that already names https", () => {
    expect(normalizeWebsite("https://example.com")).toBe("https://example.com");
  });

  it("recognises the scheme whatever its case", () => {
    expect(normalizeWebsite("HTTP://example.com")).toBe("HTTP://example.com");
    expect(normalizeWebsite("HtTpS://example.com")).toBe("HtTpS://example.com");
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(normalizeWebsite("  apple.com  ")).toBe("https://apple.com");
    expect(normalizeWebsite("  http://apple.com  ")).toBe("http://apple.com");
  });

  it("tells apart the three ways a field can be absent", () => {
    // A PATCH that omits the field must not clear it; one that sends null or
    // the empty string a form gives for an emptied input must.
    expect(normalizeWebsite(undefined)).toBeUndefined();
    expect(normalizeWebsite(null)).toBeNull();
    expect(normalizeWebsite("")).toBeNull();
    expect(normalizeWebsite("   ")).toBeNull();
  });

  it("does not invent a scheme for something schemeless and odd", () => {
    // Not this function's job to validate -- the DTO's @IsUrl whitelist has
    // already rejected anything that is not http/https by the time we run.
    expect(normalizeWebsite("apple.com/a b")).toBe("https://apple.com/a b");
  });
});
