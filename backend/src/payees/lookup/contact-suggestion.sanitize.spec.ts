import {
  CONTACT_FIELD_MAX_LENGTH,
  parseContactJson,
  sanitizeContactSuggestion,
} from "./contact-suggestion.sanitize";

const full = {
  website: "acme.example",
  address: "1 Main St, Springfield",
  email: "hello@acme.example",
  phone: "+1 555 010 2000",
  confidence: "high",
  notes: "From the official site.",
};

describe("sanitizeContactSuggestion", () => {
  it("normalizes a bare domain to https and keeps every valid field", () => {
    expect(sanitizeContactSuggestion(full, "ai-web-search")).toEqual({
      website: "https://acme.example",
      address: "1 Main St, Springfield",
      email: "hello@acme.example",
      phone: "+1 555 010 2000",
      source: "ai-web-search",
      confidence: "high",
      notes: "From the official site.",
    });
  });

  it.each(["unknown", "N/A", "none", "null", "", "  ", "-", "Not found"])(
    "reads %j as absent",
    (sentinel) => {
      expect(
        sanitizeContactSuggestion(
          { ...full, address: sentinel, phone: sentinel },
          "ai-web-search",
        ),
      ).toMatchObject({ address: null, phone: null });
    },
  );

  it("returns null when every field is absent", () => {
    expect(
      sanitizeContactSuggestion(
        { website: null, address: "", email: "unknown", phone: undefined },
        "ai-web-search",
      ),
    ).toBeNull();
  });

  it("returns null for anything that is not an object", () => {
    expect(sanitizeContactSuggestion(null, "ai-web-search")).toBeNull();
    expect(sanitizeContactSuggestion("x", "ai-web-search")).toBeNull();
    expect(sanitizeContactSuggestion([full], "ai-web-search")).toBeNull();
  });

  describe("website", () => {
    it.each([
      "javascript:alert(1)",
      "ftp://files.acme.example",
      "acme",
      "not a url",
    ])("rejects %j", (website) => {
      expect(
        sanitizeContactSuggestion({ ...full, website }, "ai-web-search"),
      ).toMatchObject({ website: null });
    });

    it("keeps an explicit http scheme", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, website: "http://acme.example/contact" },
          "ai-web-search",
        ),
      ).toMatchObject({ website: "http://acme.example/contact" });
    });

    it("rejects one over the DTO cap", () => {
      const long = `https://acme.example/${"a".repeat(CONTACT_FIELD_MAX_LENGTH.website)}`;
      expect(
        sanitizeContactSuggestion({ ...full, website: long }, "ai-web-search"),
      ).toMatchObject({ website: null });
    });
  });

  describe("email", () => {
    it("rejects a malformed address", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, email: "hello at acme" },
          "ai-web-search",
        ),
      ).toMatchObject({ email: null });
    });
  });

  describe("phone", () => {
    it("rejects a fragment with too few digits", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, phone: "555-01" },
          "ai-web-search",
        ),
      ).toMatchObject({ phone: null });
    });

    it("strips angle brackets and collapses whitespace, within the cap", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, phone: "<b>+1   555  010 2000</b>" },
          "ai-web-search",
        ),
      ).toMatchObject({ phone: "b+1 555 010 2000/b" });
      expect(
        sanitizeContactSuggestion(
          { ...full, phone: "1".repeat(CONTACT_FIELD_MAX_LENGTH.phone + 1) },
          "ai-web-search",
        ),
      ).toMatchObject({ phone: null });
    });
  });

  describe("address", () => {
    it("keeps envelope line breaks, trimming each line and dropping blank ones", () => {
      expect(
        sanitizeContactSuggestion(
          {
            ...full,
            address:
              "1373 Avenue du Mont-Royal Est\r\n  Montreal,   Quebec H2J 1Y8\n\n\nCanada  ",
          },
          "ai-web-search",
        ),
      ).toMatchObject({
        address:
          "1373 Avenue du Mont-Royal Est\nMontreal, Quebec H2J 1Y8\nCanada",
      });
    });

    it("rejects an address with more lines than an envelope has", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, address: "a\nb\nc\nd\ne\nf\ng" },
          "ai-web-search",
        ),
      ).toMatchObject({ address: null });
    });

    it("strips angle brackets, collapses spaces within a line and caps the length", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, address: "  1 Main St,\n  <i>Springfield</i>  " },
          "ai-web-search",
        ),
      ).toMatchObject({ address: "1 Main St,\niSpringfield/i" });
      expect(
        sanitizeContactSuggestion(
          {
            ...full,
            address: "x".repeat(CONTACT_FIELD_MAX_LENGTH.address + 1),
          },
          "ai-web-search",
        ),
      ).toMatchObject({ address: null });
    });
  });

  describe("confidence and notes", () => {
    it("keeps only the three known confidence values", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, confidence: "very" },
          "ai-web-search",
        ),
      ).toMatchObject({ confidence: null });
    });

    it("flattens notes to one bounded line", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, notes: `line one\nline two ${"x".repeat(400)}` },
          "ai-web-search",
        )?.notes,
      ).toHaveLength(300);
    });
  });

  describe("trust by source", () => {
    it.each(["ai-knowledge", "ai-relay"] as const)(
      "%s keeps address and phone only at high confidence",
      (source) => {
        expect(
          sanitizeContactSuggestion({ ...full, confidence: "medium" }, source),
        ).toEqual(
          expect.objectContaining({
            website: "https://acme.example",
            email: "hello@acme.example",
            address: null,
            phone: null,
            source,
          }),
        );
        expect(
          sanitizeContactSuggestion({ ...full, confidence: "high" }, source),
        ).toMatchObject({
          address: "1 Main St, Springfield",
          phone: "+1 555 010 2000",
        });
      },
    );

    it("a verified web search keeps them at any confidence", () => {
      expect(
        sanitizeContactSuggestion(
          { ...full, confidence: "low" },
          "ai-web-search",
        ),
      ).toMatchObject({
        address: "1 Main St, Springfield",
        phone: "+1 555 010 2000",
      });
    });

    it("an unverified answer with only local details sanitizes to null", () => {
      expect(
        sanitizeContactSuggestion(
          {
            website: null,
            email: null,
            address: "1 Main St",
            phone: "+1 555 010 2000",
            confidence: "low",
          },
          "ai-knowledge",
        ),
      ).toBeNull();
    });
  });
});

describe("parseContactJson", () => {
  it("parses a bare object", () => {
    expect(parseContactJson('{"website":"a.example"}')).toEqual({
      website: "a.example",
    });
  });

  it("parses an object wrapped in prose and a code fence", () => {
    expect(
      parseContactJson(
        'Here you go:\n```json\n{"website":"a.example","phone":null}\n```\nHope that helps.',
      ),
    ).toEqual({ website: "a.example", phone: null });
  });

  it.each(["no json here", "[1,2]", '{"broken":', "", '"just a string"'])(
    "returns null for %j",
    (content) => {
      expect(parseContactJson(content)).toBeNull();
    },
  );
});
