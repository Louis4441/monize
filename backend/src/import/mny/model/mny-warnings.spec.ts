import {
  MAX_FLAGGED_ROWS,
  MAX_WARNING_SAMPLES,
  MNY_WARNING_CODES,
  MnyWarning,
  MnyWarningRow,
  summarizeWarnings,
  warningLookup,
} from "./mny-warnings";

function row(overrides: Partial<MnyWarningRow> = {}): MnyWarningRow {
  return {
    handle: 101,
    accountKey: "acct-1",
    date: "2024-03-15",
    amount: -250.5,
    payeeHandle: 30,
    reference: "204",
    memo: "Quarterly",
    ...overrides,
  };
}

const LOOKUP = warningLookup({
  accounts: [{ key: "acct-1", name: "Chequing", currencyCode: "CAD" }],
  payeeNameByHandle: new Map([[30, "Acme Supplies"]]),
});

describe("mny warnings", () => {
  it("has unique codes", () => {
    expect(new Set(MNY_WARNING_CODES).size).toBe(MNY_WARNING_CODES.length);
  });

  describe("summarizeWarnings", () => {
    it("returns nothing for no warnings", () => {
      expect(summarizeWarnings([])).toEqual([]);
    });

    it("groups by code and counts", () => {
      const warnings: MnyWarning[] = [
        { code: "degeneratePayeeSkipped", subject: "#" },
        { code: "degeneratePayeeSkipped", subject: "*" },
        { code: "unknownAccountType", subject: "Mystery", detail: "at=99" },
      ];

      expect(summarizeWarnings(warnings)).toEqual([
        {
          code: "unknownAccountType",
          count: 1,
          samples: ["Mystery"],
          rows: [],
          rowsTruncated: false,
        },
        {
          code: "degeneratePayeeSkipped",
          count: 2,
          samples: ["#", "*"],
          rows: [],
          rowsTruncated: false,
        },
      ]);
    });

    it("orders groups by the declared code order, not by first appearance", () => {
      const summaries = summarizeWarnings([
        { code: "balanceMismatch", subject: "Chequing" },
        { code: "missingTable", subject: "BILL" },
      ]);

      expect(summaries.map((entry) => entry.code)).toEqual([
        "missingTable",
        "balanceMismatch",
      ]);
    });

    it("caps samples so a warning over thousands of rows stays a small payload", () => {
      const warnings: MnyWarning[] = Array.from({ length: 4000 }, (_, i) => ({
        code: "unusableTransaction" as const,
        subject: `htrn=${i}`,
      }));

      const [summary] = summarizeWarnings(warnings);

      expect(summary.count).toBe(4000);
      expect(summary.samples).toHaveLength(MAX_WARNING_SAMPLES);
      expect(summary.samples[0]).toBe("htrn=0");
    });

    it("omits missing subjects from the samples but still counts them", () => {
      const summary = summarizeWarnings([
        { code: "missingField", detail: "CRNC.fHidden" },
        { code: "missingField", subject: "CRNC", detail: "fHidden" },
      ]);

      expect(summary).toEqual([
        {
          code: "missingField",
          count: 2,
          samples: ["CRNC"],
          rows: [],
          rowsTruncated: false,
        },
      ]);
    });
  });

  describe("flagged rows", () => {
    it("resolves account, currency and payee to the names Money shows", () => {
      // A user cannot search Money for `htrn=14595`. They can search it for a
      // date, an account, a payee and a cheque number, which is the whole
      // point of carrying a row rather than only a count.
      const [summary] = summarizeWarnings(
        [
          {
            code: "splitSumMismatch",
            subject: "htrn=101",
            detail: "legs -300 vs total -250.5",
            row: row(),
          },
        ],
        LOOKUP,
      );

      expect(summary.rows).toEqual([
        {
          handle: 101,
          accountName: "Chequing",
          date: "2024-03-15",
          amount: -250.5,
          currencyCode: "CAD",
          payeeName: "Acme Supplies",
          reference: "204",
          memo: "Quarterly",
          detail: "legs -300 vs total -250.5",
        },
      ]);
    });

    it("leaves a name null rather than inventing one for a handle it cannot resolve", () => {
      const [summary] = summarizeWarnings(
        [
          {
            code: "unusableTransaction",
            row: row({ accountKey: "acct-missing", payeeHandle: 999 }),
          },
        ],
        LOOKUP,
      );

      expect(summary.rows[0]).toMatchObject({
        accountName: null,
        currencyCode: null,
        payeeName: null,
        handle: 101,
      });
    });

    it("keeps a row whose account and payee are absent from the file", () => {
      const [summary] = summarizeWarnings(
        [
          {
            code: "unusableTransaction",
            detail: "no account",
            row: row({ accountKey: null, payeeHandle: null, date: null }),
          },
        ],
        LOOKUP,
      );

      expect(summary.rows).toHaveLength(1);
      expect(summary.rows[0]).toMatchObject({
        accountName: null,
        payeeName: null,
        date: null,
        detail: "no account",
      });
    });

    it("works without a lookup, which is what an unresolved caller gets", () => {
      const [summary] = summarizeWarnings([
        { code: "splitSumMismatch", row: row() },
      ]);

      expect(summary.rows[0]).toMatchObject({
        handle: 101,
        accountName: null,
        payeeName: null,
        date: "2024-03-15",
      });
    });

    it("caps the rows and says so, so a partial list never reads as complete", () => {
      // The maintainer's file raises 3,265 of this one warning; shipping every
      // row would cost roughly half a megabyte on a payload re-fetched at each
      // wizard step.
      const warnings: MnyWarning[] = Array.from({ length: 3265 }, (_, i) => ({
        code: "transferAcrossExcludedAccount" as const,
        row: row({ handle: i }),
      }));

      const [summary] = summarizeWarnings(warnings, LOOKUP);

      expect(summary.count).toBe(3265);
      expect(summary.rows).toHaveLength(MAX_FLAGGED_ROWS);
      expect(summary.rowsTruncated).toBe(true);
    });

    it("does not claim truncation when every row fits", () => {
      const [summary] = summarizeWarnings(
        [{ code: "splitSumMismatch", row: row() }],
        LOOKUP,
      );

      expect(summary.rowsTruncated).toBe(false);
    });

    it("truncates a long memo, which is free text of any length", () => {
      const [summary] = summarizeWarnings(
        [{ code: "splitSumMismatch", row: row({ memo: "x".repeat(500) }) }],
        LOOKUP,
      );

      expect(summary.rows[0].memo).toHaveLength(123);
      expect(summary.rows[0].memo?.endsWith("...")).toBe(true);
    });

    it("gives no rows to a warning that is not about a transaction", () => {
      const [summary] = summarizeWarnings(
        [{ code: "missingTable", subject: "BILL" }],
        LOOKUP,
      );

      expect(summary.rows).toEqual([]);
      expect(summary.rowsTruncated).toBe(false);
    });
  });
});
