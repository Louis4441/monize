import { fakeMnyDatabase } from "./__fixtures__/fake-mny-database";
import { readMnyFixture } from "./__fixtures__/mny-fixtures";
import {
  inspect,
  mappingSummary,
  parseInspectArgs,
  summarise,
} from "./mny-inspect";
import { openMnyFile } from "./msisam/open-mny";
import { readMnyTables } from "./tables/read-mny-tables";

describe("parseInspectArgs", () => {
  it("reads the file path from the single positional argument", () => {
    expect(parseInspectArgs(["file.mny"])).toEqual({
      file: "file.mny",
      password: undefined,
      table: undefined,
      rows: 5,
    });
  });

  it("reads the optional flags", () => {
    expect(
      parseInspectArgs([
        "--password",
        "secret",
        "file.mny",
        "--table",
        "TRN",
        "--rows",
        "2",
      ]),
    ).toEqual({ file: "file.mny", password: "secret", table: "TRN", rows: 2 });
  });

  it.each([[[]], [["a.mny", "b.mny"]]])(
    "rejects %s with a usage message",
    (argv) => {
      expect(() => parseInspectArgs(argv)).toThrow(/usage/);
    },
  );
});

describe("summarise", () => {
  it("reports the reader's view of a real file", () => {
    const lines = summarise(
      readMnyTables(openMnyFile(readMnyFixture("money2002"))),
    );

    expect(lines).toContain("  base currency:   GBP (British pound)");
    expect(lines).toContain("  accounts:        3");
    expect(lines.some((line) => line.startsWith("  transactions:    60"))).toBe(
      true,
    );
    expect(lines).toContain("  missing tables:  none");
    expect(lines).toContain("  defaulted fields: CRNC.hidden");
  });

  it("names the tables and fields a Money 2001 file cannot supply", () => {
    const lines = summarise(
      readMnyTables(openMnyFile(readMnyFixture("money2001"))),
    );

    expect(lines).toContain(
      "  bills:           not supported by this Money version",
    );
    expect(lines).toContain("  missing tables:  BILL");
    expect(lines).toContain("  defaulted fields: CRNC.hidden, TRN.billSeries");
  });

  it("says so when the file names no base currency", () => {
    const lines = summarise(readMnyTables(fakeMnyDatabase({})));

    expect(lines).toContain("  base currency:   unknown");
    expect(lines).toContain("  defaulted fields: none");
  });
});

describe("mappingSummary", () => {
  it("reports the Monize accounts a real file maps to, with balances", () => {
    const lines = mappingSummary(
      readMnyTables(openMnyFile(readMnyFixture("money2002"))),
    );

    expect(lines).toContain("  base currency:   GBP");
    // Two Money investment accounts become two Monize pairs.
    expect(lines).toContain("  accounts:        4 (0 skipped)");
    expect(
      lines.some((line) => line.includes("None Investment - Brokerage")),
    ).toBe(true);
    expect(
      lines.some((line) => line.trimStart().startsWith("transactions:")),
    ).toBe(true);
  });

  it("reports investment rows as deferred rather than as failures", () => {
    const lines = mappingSummary(
      readMnyTables(openMnyFile(readMnyFixture("money2002"))),
    );

    expect(
      lines.some((line) => line.includes("60 investment rows deferred")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("0 skipped,"))).toBe(true);
  });

  it("survives a file with no accounts at all", () => {
    const lines = mappingSummary(readMnyTables(fakeMnyDatabase({})));

    expect(lines).toContain("  accounts:        0 (0 skipped)");
  });
});

describe("inspect", () => {
  it("reports the encryption scheme and every table", () => {
    const lines = inspect(readMnyFixture("money2002"), { rows: 5 });

    expect(lines[0]).toContain("new-md5");
    expect(lines[1]).toContain("no");
    expect(lines[2]).toContain("86");
    expect(lines.some((line) => /ACCT\s+3 rows/.test(line))).toBe(true);
    expect(lines.some((line) => /TRN\s+60 rows/.test(line))).toBe(true);
  });

  it("reports a password protected file as such", () => {
    const lines = inspect(readMnyFixture("money2008Pwd"), {
      password: "Test12345",
      rows: 5,
    });

    expect(lines[1]).toContain("yes");
  });

  it("prints the requested number of rows from a table", () => {
    const lines = inspect(readMnyFixture("money2001"), {
      table: "CRNC",
      rows: 2,
    });

    const start = lines.indexOf("first rows of CRNC:");
    expect(start).toBeGreaterThan(-1);
    expect(lines[start + 1]).toContain('"szIsoCode":"ARS"');
    expect(lines[start + 3]).toBe("");
  });

  it("keeps reporting after a damaged table definition", () => {
    const file = readMnyFixture("money2002");
    // Page 15 holds the ACCT table definition; the catalogue stays readable.
    file.fill(0xff, 15 * 4096, 16 * 4096);

    const lines = inspect(file, { rows: 5 });

    expect(lines.some((line) => /ACCT\s+unreadable:/.test(line))).toBe(true);
    expect(lines.some((line) => /TRN\s+60 rows/.test(line))).toBe(true);
    expect(lines.some((line) => line.startsWith("summary unavailable:"))).toBe(
      true,
    );
  });

  it("notes a table the Money version does not have", () => {
    const lines = inspect(readMnyFixture("money2001"), {
      table: "BILL",
      rows: 5,
    });

    expect(lines).toContain("  (table not present in this Money version)");
  });
});
