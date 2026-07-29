import { AccountType } from "../../accounts/entities/account.entity";
import { TransactionStatus } from "../../transactions/entities/transaction.entity";
import { MNY_FIXTURES, readMnyFixture } from "./__fixtures__/mny-fixtures";
import {
  mnyAccount,
  mnyCurrency,
  mnyDefaults,
  referenceData,
} from "./__fixtures__/mny-row-builders";
import { mapAccounts } from "./map/map-reference";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";
import { MappedTransactions } from "./model/mny-import-model";
import {
  MnyParserService,
  computeExpectedBalances,
  todayIsoDate,
} from "./mny-parser.service";
import { buildPreview } from "./mny-preview";

describe("todayIsoDate", () => {
  it("formats from local calendar components, not a UTC shift", () => {
    // 23:30 local on the 5th must be the 5th, whatever the offset.
    expect(todayIsoDate(new Date(2026, 6, 5, 23, 30))).toBe("2026-07-05");
    expect(todayIsoDate(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });
});

describe("computeExpectedBalances", () => {
  function accountsWith(openingBalance: number) {
    return mapAccounts(
      referenceData({
        currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
        defaults: mnyDefaults({ defaultCurrency: 1 }),
        accounts: [mnyAccount({ handle: 1, name: "Chequing", openingBalance })],
      }),
      DEFAULT_MNY_IMPORT_OPTIONS,
      "USD",
    );
  }

  function transactionsWith(
    rows: Array<{ amount: number; date: string; status?: TransactionStatus }>,
  ): MappedTransactions {
    return {
      transactions: rows.map((row, index) => ({
        id: `id-${index}`,
        handle: index + 1,
        accountKey: "acct-1",
        transactionDate: row.date,
        amount: row.amount,
        currencyCode: "USD",
        status: row.status ?? TransactionStatus.CLEARED,
        payeeHandle: null,
        categoryHandle: null,
        description: null,
        referenceNumber: null,
        isTransfer: false,
        linkedTransactionId: null,
        splits: [],
      })),
      referencedPayees: new Set(),
      referencedCategories: new Set(),
      transfersLinked: 0,
      skipped: 0,
      deferredInvestments: 0,
      warnings: [],
    };
  }

  it("adds the opening balance to every posting", () => {
    const balances = computeExpectedBalances(
      accountsWith(100),
      transactionsWith([
        { amount: -25.5, date: "2026-01-02" },
        { amount: 10.25, date: "2026-01-03" },
      ]),
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(84.75);
  });

  it("excludes voided transactions, as Monize's own balance query does", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith([
        { amount: -50, date: "2026-01-02" },
        { amount: -999, date: "2026-01-03", status: TransactionStatus.VOID },
      ]),
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(-50);
  });

  it("excludes future-dated transactions so a post-dated cheque is not a discrepancy", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith([
        { amount: -50, date: "2026-07-01" },
        { amount: -500, date: "2026-08-01" },
      ]),
      "2026-07-29",
    );

    expect(balances.get("acct-1")).toBe(-50);
  });

  it("includes a transaction dated exactly on the cut-off", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith([{ amount: -50, date: "2026-07-29" }]),
      "2026-07-29",
    );

    expect(balances.get("acct-1")).toBe(-50);
  });

  it("does not drift over many fractional amounts", () => {
    // Float accumulation of 0.1 three thousand times is visibly wrong.
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith(
        Array.from({ length: 3000 }, () => ({
          amount: 0.1,
          date: "2026-01-02",
        })),
      ),
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(300);
  });

  it("ignores a transaction in an account that is not being imported", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      {
        ...transactionsWith([{ amount: -50, date: "2026-01-02" }]),
        transactions: [
          {
            ...transactionsWith([{ amount: -50, date: "2026-01-02" }])
              .transactions[0],
            accountKey: "acct-999",
          },
        ],
      },
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(0);
  });
});

describe("MnyParserService", () => {
  const service = new MnyParserService();

  describe("every committed fixture", () => {
    it.each(Object.keys(MNY_FIXTURES) as Array<keyof typeof MNY_FIXTURES>)(
      "parses %s end to end",
      (name) => {
        const parsed = service.parse({
          buffer: readMnyFixture(name),
          password: MNY_FIXTURES[name].password,
          userDefaultCurrency: "CAD",
        });

        expect(parsed.accounts.accounts.length).toBeGreaterThan(0);
        expect(parsed.baseCurrency).toMatch(/^[A-Z]{3}$/);
        expect(parsed.expectedBalances.size).toBe(
          parsed.accounts.accounts.length,
        );
      },
    );
  });

  describe("era detection", () => {
    it.each([
      ["money2001", "money2001"],
      ["money2002", "money2002"],
      ["money2008", "moneyPlus"],
    ] as const)("reports %s as %s", (fixture, era) => {
      const parsed = service.parse({
        buffer: readMnyFixture(fixture),
        userDefaultCurrency: "CAD",
      });

      expect(parsed.era).toBe(era);
    });
  });

  describe("money2008.mny", () => {
    const parse = () =>
      service.parse({
        buffer: readMnyFixture("money2008"),
        userDefaultCurrency: "CAD",
        asOf: "2026-07-29",
      });

    it("takes USD from the file, not the user's preference", () => {
      expect(parse().baseCurrency).toBe("USD");
    });

    it("turns its single investment account into a linked pair", () => {
      const parsed = parse();

      expect(parsed.accounts.accounts).toHaveLength(2);
      expect(
        parsed.accounts.accounts.every(
          (account) => account.accountType === AccountType.INVESTMENT,
        ),
      ).toBe(true);
      expect(parsed.accounts.accounts.map((a) => a.name)).toEqual([
        "Investments to Watch - Cash",
        "Investments to Watch - Brokerage",
      ]);
    });

    it("defers all three of its investment transactions", () => {
      const parsed = parse();

      // Every transaction in this file carries a security (act 1, SELL).
      expect(parsed.transactions.transactions).toEqual([]);
      expect(parsed.transactions.deferredInvestments).toBe(3);
      expect(parsed.transactions.skipped).toBe(0);
    });

    it("computes both sides' balances as their opening balances", () => {
      const parsed = parse();

      // Hand-computed: amtOpen is 0 on the account and there are no banking
      // postings to move it.
      for (const account of parsed.accounts.accounts) {
        expect(parsed.expectedBalances.get(account.key)).toBe(0);
      }
    });

    it("reports no missing tables and no defaulted fields", () => {
      const parsed = parse();

      expect(parsed.missingTables).toEqual([]);
      expect(parsed.missingFields).toEqual([]);
    });

    it("counts only real securities, not currency pseudo-securities", () => {
      const parsed = parse();

      expect(parsed.fileCounts.securities).toBe(3);
      // 128 CAT rows, less Money's two structural roots.
      expect(parsed.fileCounts.categories).toBe(126);
    });
  });

  describe("money2001.mny", () => {
    it("degrades gracefully over the tables it does not have", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2001"),
        userDefaultCurrency: "CAD",
      });

      // The missing BILL table is what crash-looped the PR #192 proof of concept.
      expect(parsed.missingTables).toContain("BILL");
      expect(parsed.warnings).toEqual(
        expect.arrayContaining([{ code: "missingTable", subject: "BILL" }]),
      );
      expect(parsed.accounts.accounts.length).toBeGreaterThan(0);
    });
  });

  describe("password handling", () => {
    it("opens a protected file with the right password", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008Pwd"),
        password: MNY_FIXTURES.money2008Pwd.password,
        userDefaultCurrency: "CAD",
      });

      expect(parsed.passwordProtected).toBe(true);
    });

    it("reports a protected file as needing a password", () => {
      expect(() =>
        service.parse({
          buffer: readMnyFixture("money2008Pwd"),
          userDefaultCurrency: "CAD",
        }),
      ).toThrow(expect.objectContaining({ code: "mnyPasswordRequired" }));
    });

    it("tells a wrong password apart from a missing one", () => {
      expect(() =>
        service.parse({
          buffer: readMnyFixture("money2008Pwd"),
          password: "not-the-password",
          userDefaultCurrency: "CAD",
        }),
      ).toThrow(expect.objectContaining({ code: "mnyPasswordIncorrect" }));
    });

    it("opens an unprotected file that still carries crypt-check bytes", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008"),
        userDefaultCurrency: "CAD",
      });

      expect(parsed.passwordProtected).toBe(false);
    });
  });

  describe("options", () => {
    it("echoes the resolved options, filling server-side defaults", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008"),
        options: { wipeExistingData: true },
        userDefaultCurrency: "CAD",
      });

      expect(parsed.options.wipeExistingData).toBe(true);
      expect(parsed.options.referencedOnlyPayees).toBe(true);
    });

    it("honours an account exclusion, dropping the pair it belongs to", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008"),
        options: {
          accounts: [{ handle: 1, include: false, currencyOverride: null }],
        },
        userDefaultCurrency: "CAD",
      });

      expect(parsed.accounts.accounts).toEqual([]);
    });
  });
});

describe("buildPreview", () => {
  const service = new MnyParserService();

  function preview() {
    return buildPreview({
      parsed: service.parse({
        buffer: readMnyFixture("money2002"),
        userDefaultCurrency: "CAD",
        asOf: "2026-07-29",
      }),
      stagedFileId: "staged-1",
      filename: "money2002.mny",
      sizeBytes: 123456,
    });
  }

  it("carries the staged file identity the import call needs", () => {
    expect(preview()).toMatchObject({
      stagedFileId: "staged-1",
      filename: "money2002.mny",
      sizeBytes: 123456,
    });
  });

  it("reports the file's own base currency and era", () => {
    expect(preview()).toMatchObject({ baseCurrency: "GBP", era: "money2002" });
  });

  it("gives every account a review row with both balances", () => {
    const rows = preview().accounts;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.openingBalance).toBe("number");
      expect(typeof row.finalBalance).toBe("number");
      expect(row.currencyCode).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("shows referenced-versus-total counts for payees and categories", () => {
    const counts = preview().counts;

    expect(counts.categoriesInFile).toBeGreaterThan(counts.categoriesToCreate);
    expect(counts.accountsIncluded).toBeGreaterThan(0);
  });

  it("surfaces the file's defaulted fields as a notice", () => {
    // money2002 has no CRNC.fHidden column.
    expect(preview().missingFields).toContain("CRNC.hidden");
  });

  it("carries no row data, only summaries", () => {
    const payload = JSON.stringify(preview());

    // 60 transactions and 86 securities must not appear in the payload.
    expect(payload).not.toContain("htrn");
    expect(payload.length).toBeLessThan(20000);
  });

  it("groups warnings by code rather than listing every occurrence", () => {
    for (const warning of preview().warnings) {
      expect(typeof warning.count).toBe("number");
      expect(warning.samples.length).toBeLessThanOrEqual(5);
    }
  });
});
