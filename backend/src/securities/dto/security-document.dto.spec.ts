import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSecurityDocumentDto } from "./create-security-document.dto";
import { UpdateSecurityDocumentDto } from "./update-security-document.dto";
import { SecurityDocumentType } from "../entities/security-document.entity";

function dto(partial: Record<string, unknown> = {}): CreateSecurityDocumentDto {
  return plainToInstance(CreateSecurityDocumentDto, {
    name: "2024 Annual Report",
    url: "https://www.ishares.com/report.pdf",
    ...partial,
  });
}

async function failures(instance: object): Promise<string[]> {
  const errors = await validate(instance);
  return errors.map((error) => error.property);
}

describe("CreateSecurityDocumentDto", () => {
  it("accepts a plain https document link", async () => {
    expect(await failures(dto())).toEqual([]);
  });

  it("accepts every document type it offers", async () => {
    for (const documentType of Object.values(SecurityDocumentType)) {
      expect(await failures(dto({ documentType }))).toEqual([]);
    }
  });

  it("accepts a document with no date, which many carry", async () => {
    expect(await failures(dto({ documentDate: undefined }))).toEqual([]);
  });

  describe("the URL is rendered as a link, so its scheme is a security control", () => {
    // The Open action turns this value into an anchor. Any scheme that can run
    // code turns a stored document into stored XSS, so these are the tests that
    // matter most in this file.
    it.each([
      ["javascript:alert(1)"],
      ["JavaScript:alert(1)"],
      ["data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
      ["vbscript:msgbox(1)"],
      ["file:///etc/passwd"],
    ])("refuses %s", async (url) => {
      expect(await failures(dto({ url }))).toContain("url");
    });

    it("refuses an address with no scheme at all", async () => {
      // Nothing should have to infer one; an inferred scheme is a guess.
      expect(await failures(dto({ url: "www.example.com/a.pdf" }))).toContain(
        "url",
      );
    });

    it("allows plain http, which plenty of issuer archives still serve", async () => {
      expect(await failures(dto({ url: "http://example.com/a.pdf" }))).toEqual(
        [],
      );
    });
  });

  it("requires a name", async () => {
    expect(await failures(dto({ name: undefined }))).toContain("name");
  });

  it("bounds the name and the URL to what the columns hold", async () => {
    expect(await failures(dto({ name: "a".repeat(256) }))).toContain("name");
    expect(
      await failures(dto({ url: `https://e.com/${"a".repeat(2100)}` })),
    ).toContain("url");
  });

  it("strips markup out of the name rather than storing it", async () => {
    const instance = dto({ name: "<script>alert(1)</script>Report" });
    expect(instance.name).not.toContain("<script>");
  });

  it("refuses a type it does not know", async () => {
    expect(await failures(dto({ documentType: "INVOICE" }))).toContain(
      "documentType",
    );
  });
});

describe("UpdateSecurityDocumentDto", () => {
  it("accepts a partial change", async () => {
    const instance = plainToInstance(UpdateSecurityDocumentDto, {
      name: "Renamed",
    });
    expect(await failures(instance)).toEqual([]);
  });

  it("applies the same scheme check as create", async () => {
    // An edit must not be a way in for an address a create would refuse.
    const instance = plainToInstance(UpdateSecurityDocumentDto, {
      url: "javascript:alert(1)",
    });
    expect(await failures(instance)).toContain("url");
  });
});
