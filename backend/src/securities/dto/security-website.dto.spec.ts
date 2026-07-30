import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSecurityDto } from "./create-security.dto";
import { UpdateSecurityDto } from "./update-security.dto";

/**
 * The two address fields on a security are optional, and an optional text input
 * that the user leaves alone does not arrive as `undefined` -- react-hook-form
 * gives `""`, and the form sends it. `@IsOptional()` waives validation for
 * `undefined` and `null` only, so a format validator sitting beside it still
 * runs on the empty string and rejects it.
 *
 * That is not a cosmetic defect in an optional field: `forbidNonWhitelisted`
 * validation is all-or-nothing per request, so one rejected property fails the
 * whole save. Adding these two columns broke *every* create and update from the
 * securities form, and only the E2E suite noticed.
 */
function create(partial: Record<string, unknown> = {}): CreateSecurityDto {
  return plainToInstance(CreateSecurityDto, {
    symbol: "AAPL",
    name: "Apple Inc.",
    currencyCode: "USD",
    ...partial,
  });
}

async function failures(instance: object): Promise<string[]> {
  const errors = await validate(instance);
  return errors.map((error) => error.property).sort();
}

describe("a security's optional addresses", () => {
  it.each([["website"], ["irWebsite"]])(
    "accepts %s left blank by the form",
    async (field) => {
      // The regression: this is what the form actually sends for an untouched
      // field, and it used to 400 the entire request.
      expect(await failures(create({ [field]: "" }))).toEqual([]);
    },
  );

  it("accepts both addresses blank at once, which is the common case", async () => {
    expect(await failures(create({ website: "", irWebsite: "" }))).toEqual([]);
  });

  it.each([["website"], ["irWebsite"]])(
    "accepts %s explicitly cleared to null",
    async (field) => {
      expect(await failures(create({ [field]: null }))).toEqual([]);
    },
  );

  it.each([["website"], ["irWebsite"]])(
    "accepts %s omitted entirely",
    async (field) => {
      expect(await failures(create({ [field]: undefined }))).toEqual([]);
    },
  );

  it("accepts a bare domain, so nobody has to type a scheme", async () => {
    expect(await failures(create({ website: "apple.com" }))).toEqual([]);
  });

  it("accepts a full https address", async () => {
    expect(
      await failures(create({ website: "https://investor.apple.com/" })),
    ).toEqual([]);
  });

  describe("waiving the blank case must not waive the scheme check", () => {
    // Both fields are rendered as anchors on the detail page, so a scheme that
    // can run code is stored XSS. These are the tests that matter most here:
    // they prove the fix above widened the accepted set by exactly `""`.
    it.each([
      ["javascript:alert(1)"],
      ["data:text/html,<script>alert(1)</script>"],
      ["vbscript:msgbox(1)"],
      ["file:///etc/passwd"],
      ["not a url at all"],
    ])("rejects %s as a website", async (value) => {
      expect(await failures(create({ website: value }))).toEqual(["website"]);
    });

    it("rejects a bad investor-relations address just the same", async () => {
      expect(
        await failures(create({ irWebsite: "javascript:alert(1)" })),
      ).toEqual(["irWebsite"]);
    });

    it("rejects an address longer than the column", async () => {
      const tooLong = `https://example.com/${"a".repeat(2048)}`;
      expect(await failures(create({ website: tooLong }))).toEqual(["website"]);
    });
  });

  describe("the update DTO inherits all of it", () => {
    // UpdateSecurityDto is a PartialType of the create DTO, so the edit form --
    // the one that clears an address by submitting "" -- shares these rules.
    it("accepts a blank address on edit, which is how a link is removed", async () => {
      const instance = plainToInstance(UpdateSecurityDto, {
        website: "",
        irWebsite: "",
      });
      expect(await failures(instance)).toEqual([]);
    });

    it("still rejects a dangerous scheme on edit", async () => {
      const instance = plainToInstance(UpdateSecurityDto, {
        website: "javascript:alert(1)",
      });
      expect(await failures(instance)).toEqual(["website"]);
    });
  });
});
