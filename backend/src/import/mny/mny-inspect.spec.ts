import { fakeMnyDatabase } from "./__fixtures__/fake-mny-database";
import { readMnyFixture } from "./__fixtures__/mny-fixtures";
import {
  inspect,
  mappingSummary,
  parseInspectArgs,
  signSummary,
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

  it("reports the securities and investment rows the file maps to", () => {
    const lines = mappingSummary(
      readMnyTables(openMnyFile(readMnyFixture("money2002"))),
    );

    // Every transaction in this fixture carries a security, and the currency
    // pseudo-securities are excluded from the 86 real ones.
    expect(
      lines.some((line) => line.trimStart().startsWith("securities:")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("investments:     60"))).toBe(
      true,
    );
  });

  // money2002.mny has 60 open LOT rows and 60 act=15 transactions, which is the
  // whole point of the cross-check: two independent readings of the same
  // positions, agreeing.
  it("reconciles the open lots against the action replay on a real file", () => {
    const lines = mappingSummary(
      readMnyTables(openMnyFile(readMnyFixture("money2002"))),
    );

    const start =
      lines.findIndex((line) =>
        line.includes("holdings (open lots vs action replay)"),
      ) + 2;
    const rows = lines.slice(start).slice(
      0,
      lines.slice(start).findIndex((line) => line.trim() === ""),
    );

    // 60 lots and 60 act=15 rows across 30 securities, every position agreeing.
    expect(rows).toHaveLength(30);
    expect(rows.every((line) => line.endsWith("  ok"))).toBe(true);
  });

  it("reports the signs the writer would actually insert", () => {
    // Distinct from the raw `TRN.amt` block, which counts every row in the
    // table. This counts only what this import would create, so a file whose
    // raw amounts are signed but whose mapped amounts are not localises the
    // fault to the mapper rather than to the reader or the writer.
    const lines = mappingSummary(
      readMnyTables(openMnyFile(readMnyFixture("money2002"))),
    );

    const block = lines.join("\n");
    expect(block).toMatch(
      /txn amounts:\s+\d+ positive, \d+ negative, \d+ zero/,
    );
    expect(block).toMatch(/split legs:\s+\d+ positive, \d+ negative, \d+ zero/);
    expect(block).toMatch(
      /investment cash:\s+\d+ positive, \d+ negative, \d+ zero/,
    );
  });

  it("omits the holdings block for a file with no LOT rows", () => {
    const lines = mappingSummary(
      readMnyTables(openMnyFile(readMnyFixture("money2001"))),
    );

    expect(lines.some((line) => line.includes("holdings (open lots"))).toBe(
      false,
    );
  });

  it("survives a file with no accounts at all", () => {
    const lines = mappingSummary(readMnyTables(fakeMnyDatabase({})));

    expect(lines).toContain("  accounts:        0 (0 skipped)");
  });
});

describe("signSummary", () => {
  it("counts how TRN.amt is signed and lists the columns TRN has", () => {
    // Monize has no income/expense column: the sign of `amount` is the
    // direction. No committed fixture has a banking transaction, so whether
    // Money signs `amt` at all can only be read off a real file -- which is
    // what this block exists to answer.
    const db = openMnyFile(readMnyFixture("money2002"));
    const lines = signSummary(readMnyTables(db), db);

    expect(lines[0]).toBe("TRN.amt signs:");
    const block = lines.join("\n");
    expect(block).toMatch(/positive:\s+\d+/);
    expect(block).toMatch(/negative:\s+\d+/);
    expect(block).toMatch(/transfer sides:\s+\d+ \(\d+ positive\)/);
    // The column list is the lead when the sign turns out not to be in `amt`.
    expect(block).toContain("amt");
    expect(block).toContain("hacct");
  });

  it("says so when the file has no TRN table at all", () => {
    const db = openMnyFile(readMnyFixture("money2002"));
    const tables = readMnyTables(db);

    const lines = signSummary(tables, {
      ...db,
      getTableOrNull: () => null,
    });

    expect(lines.join("\n")).toContain("(no TRN table)");
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

  it("reports the stage timings and peak memory task M4.1 records", () => {
    // The acceptance numbers can only come from a real Money Plus file, which
    // never enters the repository -- so the harness has to measure itself.
    const lines = inspect(readMnyFixture("money2002"), { rows: 5 });
    const start = lines.indexOf("performance:");

    expect(start).toBeGreaterThan(-1);
    const block = lines.slice(start, start + 6).join("\n");
    expect(block).toMatch(/file size\s+2\.6 MiB/);
    expect(block).toMatch(/decrypt \+ open\s+\d+ ms/);
    expect(block).toMatch(/read tables\s+\d+ ms/);
    expect(block).toMatch(/map\s+\d+ ms/);
    expect(block).toMatch(/peak rss\s+[\d.]+ MiB \([\d.]+x file size\)/);
  });

  it("still reports performance after a damaged table stops the summary", () => {
    const file = readMnyFixture("money2002");
    file.fill(0xff, 15 * 4096, 16 * 4096);

    const lines = inspect(file, { rows: 5 });

    expect(lines).toContain("performance:");
  });
});
