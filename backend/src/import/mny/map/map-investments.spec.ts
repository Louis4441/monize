import { AccountSubType } from "../../../accounts/entities/account.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  investmentData,
  mnyBill,
  mnyInvestmentDetail,
  mnySecurity,
  mnySecurityPrice,
  mnySecuritySplit,
  mnySplit,
  mnyTransaction,
  transactionData,
} from "../__fixtures__/mny-row-builders";
import { MappedAccounts, MappedSecurities } from "../model/mny-import-model";
import { MNY_ACTION } from "../model/mny-model";
import { mapSecurities } from "./map-securities";
import { MapInvestmentsInput, mapInvestments } from "./map-investments";

/**
 * A Money investment account is an `at = 5` row plus its cash companion, which
 * `mapAccounts` turns into a linked brokerage/cash pair. These fixtures build
 * that shape directly: `hacct` 10 is the brokerage, `hacct` 11 its cash sleeve.
 */
function accountsFixture(handles: number[] = [10]): MappedAccounts {
  const accounts = handles.flatMap((handle) => [
    {
      key: `acct-${handle + 1}`,
      handle: handle + 1,
      name: `Brokerage ${handle} - Cash`,
      moneyName: `Brokerage ${handle} (Cash)`,
      accountType: "INVESTMENT" as never,
      accountSubType: AccountSubType.INVESTMENT_CASH,
      currencyCode: "USD",
      openingBalance: 0,
      creditLimit: null,
      closed: false,
      closedDate: null,
      favourite: false,
      description: null,
      linkedKey: `acct-${handle}`,
    },
    {
      key: `acct-${handle}`,
      handle,
      name: `Brokerage ${handle} - Investments`,
      moneyName: `Brokerage ${handle}`,
      accountType: "INVESTMENT" as never,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      currencyCode: "USD",
      openingBalance: 0,
      creditLimit: null,
      closed: false,
      closedDate: null,
      favourite: false,
      description: null,
      linkedKey: `acct-${handle + 1}`,
    },
  ]);

  return {
    baseCurrency: "USD",
    currencyCodes: ["USD"],
    accounts,
    keyByHandle: new Map(accounts.map((a) => [a.handle as number, a.key])),
    currencyByHandle: new Map(
      accounts.map((a) => [a.handle as number, a.currencyCode]),
    ),
    skipped: 0,
    warnings: [],
  };
}

function securitiesFixture(handles: number[] = [1]): MappedSecurities {
  return mapSecurities({
    securities: handles.map((handle) =>
      mnySecurity({
        handle,
        symbol: `SEC${handle}`,
        name: `Security ${handle}`,
      }),
    ),
    currencyByHandle: new Map(),
    baseCurrency: "USD",
  });
}

function input(
  overrides: Partial<MapInvestmentsInput> = {},
): MapInvestmentsInput {
  return {
    transactions: transactionData(),
    investments: investmentData(),
    accounts: accountsFixture(),
    securities: securitiesFixture(),
    bills: [],
    ...overrides,
  };
}

/** A `TRN` row in the brokerage account carrying a security. */
function invRow(overrides: Parameters<typeof mnyTransaction>[0] = {}) {
  return mnyTransaction({ account: 10, security: 1, ...overrides });
}

describe("mapInvestments", () => {
  describe("action mapping", () => {
    it("maps a buy with its quantity, price and commission", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, amount: -1009.99 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 10,
                price: 100,
                commission: 9.99,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        handle: 1,
        accountKey: "acct-10",
        cashAccountKey: "acct-11",
        securityHandle: 1,
        action: InvestmentAction.BUY,
        quantity: 10,
        price: 100,
        commission: 9.99,
        totalAmount: 1009.99,
        cashAmount: -1009.99,
        currencyCode: "USD",
      });
    });

    it("maps a sell with cash arriving in the sleeve", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.SELL, amount: 990.01 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 10,
                price: 100,
                commission: 9.99,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.SELL,
        totalAmount: 990.01,
        cashAmount: 990.01,
      });
    });

    // PR #192 iterated TRN_INV and so dropped every cash dividend in the file.
    it("maps an act=4 dividend, which has no TRN_INV row at all", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.DIVIDEND, amount: 42.5 }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.DIVIDEND,
        quantity: null,
        price: null,
        totalAmount: 42.5,
        cashAmount: 42.5,
        cashAccountKey: "acct-11",
      });
      expect(
        result.warnings.filter((w) => w.code === "missingInvestmentDetail"),
      ).toHaveLength(0);
    });

    // The PoC mapped act=16 to SELL, inventing proceeds and wrecking cost basis.
    it("maps act=16 to REMOVE_SHARES, never SELL", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.REMOVE_SHARES,
                amount: 0,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({ transaction: 1, quantity: 5, price: 100 }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.REMOVE_SHARES,
        quantity: 5,
        totalAmount: 0,
        cashAmount: 0,
        cashAccountKey: null,
      });
    });

    it("gives a reinvestment a value but no cash leg", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.REINVEST, amount: 250 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 2.5,
                price: 100,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.REINVEST,
        totalAmount: 250,
        cashAmount: 0,
        cashAccountKey: null,
      });
    });

    it("takes quantity as positive even when Money stored it signed", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [invRow({ handle: 1, action: MNY_ACTION.SELL })],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: -10,
                price: 100,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0].quantity).toBe(10);
      expect(result.transactions[0].action).toBe(InvestmentAction.SELL);
    });

    it("skips an unknown act code and counts it", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [invRow({ handle: 1, action: 99 })],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([
        {
          code: "unknownInvestmentAction",
          subject: "htrn=1",
          detail: "act=99",
        },
      ]);
    });

    it("warns per row mapped through an action whose meaning is inferred", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.CAPITAL_GAIN,
                amount: 12,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0].action).toBe(InvestmentAction.CAPITAL_GAIN);
      expect(result.warnings).toContainEqual({
        code: "unconfirmedInvestmentAction",
        subject: "htrn=1",
        detail: `act=${MNY_ACTION.CAPITAL_GAIN}`,
      });
    });

    it("keeps a row whose TRN_INV detail is missing, cash only", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, amount: -500 }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.BUY,
        quantity: null,
        totalAmount: 500,
        cashAmount: -500,
      });
      expect(result.warnings).toContainEqual({
        code: "missingInvestmentDetail",
        subject: "htrn=1",
        detail: `act=${MNY_ACTION.BUY}`,
      });
    });

    it("carries the reconciliation status and void flag through", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, clearedStatus: 2 }),
              invRow({ handle: 2, action: MNY_ACTION.BUY, flags: 0x80 }),
            ],
          }),
        }),
      );

      expect(result.transactions.map((t) => t.status)).toEqual([
        TransactionStatus.RECONCILED,
        TransactionStatus.VOID,
      ]);
    });
  });

  describe("inclusion rules", () => {
    it("ignores rows with no security: those are the banking mapper's", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, account: 10, security: null }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    it("ignores recurrence templates, bill templates and split children", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, frequency: 3 }),
              invRow({ handle: 2, action: MNY_ACTION.BUY }),
              invRow({ handle: 3, action: MNY_ACTION.BUY }),
            ],
            splits: [mnySplit({ parent: 9, child: 3 })],
          }),
          bills: [mnyBill({ templateTransaction: 2 })],
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    it("ignores rows in an account the user left out", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, account: 77, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    it("skips a row whose account is not a brokerage side", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, account: 11, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(1);
      expect(result.warnings[0].code).toBe("investmentAccountMismatch");
    });

    it("skips a row whose security did not survive the securities mapper", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, security: 99, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(1);
    });

    it("skips a row with no usable date", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, date: null, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.skipped).toBe(1);
      expect(result.warnings[0].code).toBe("unusableTransaction");
    });
  });

  describe("act 15 + 16 share transfers", () => {
    const pairInput = () =>
      input({
        accounts: accountsFixture([10, 20]),
        transactions: transactionData({
          transactions: [
            invRow({
              handle: 1,
              account: 20,
              action: MNY_ACTION.ADD_SHARES,
              date: "2026-03-01",
            }),
            invRow({
              handle: 2,
              account: 10,
              action: MNY_ACTION.REMOVE_SHARES,
              date: "2026-03-01",
            }),
          ],
        }),
        investments: investmentData({
          investmentDetails: [
            mnyInvestmentDetail({ transaction: 1, quantity: 7, price: 12 }),
            mnyInvestmentDetail({ transaction: 2, quantity: 7, price: 12 }),
          ],
        }),
      });

    it("pairs them into linked TRANSFER_IN / TRANSFER_OUT rows", () => {
      const result = mapInvestments(pairInput());

      const incoming = result.transactions.find((t) => t.handle === 1);
      const outgoing = result.transactions.find((t) => t.handle === 2);

      expect(incoming?.action).toBe(InvestmentAction.TRANSFER_IN);
      expect(outgoing?.action).toBe(InvestmentAction.TRANSFER_OUT);
      expect(incoming?.linkedInvestmentId).toBe(outgoing?.id);
      expect(outgoing?.linkedInvestmentId).toBe(incoming?.id);
      expect(result.transfersPaired).toBe(1);
    });

    it("does not pair two rows in the same account", () => {
      const base = pairInput();
      const result = mapInvestments({
        ...base,
        transactions: transactionData({
          transactions: base.transactions.transactions.map((row) => ({
            ...row,
            account: 10,
          })),
        }),
      });

      expect(result.transfersPaired).toBe(0);
      expect(result.transactions.map((t) => t.action)).toEqual([
        InvestmentAction.ADD_SHARES,
        InvestmentAction.REMOVE_SHARES,
      ]);
    });

    it("does not pair across different quantities", () => {
      const base = pairInput();
      const result = mapInvestments({
        ...base,
        investments: investmentData({
          investmentDetails: [
            mnyInvestmentDetail({ transaction: 1, quantity: 7 }),
            mnyInvestmentDetail({ transaction: 2, quantity: 3 }),
          ],
        }),
      });

      expect(result.transfersPaired).toBe(0);
    });

    // Shares transferred in from a broker are the ordinary way a portfolio
    // starts, so an unpaired row is not an anomaly and must not warn --
    // money2002.mny alone has 60 of them.
    it("leaves an unpaired row as ADD_SHARES, without a warning", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.ADD_SHARES }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({ transaction: 1, quantity: 4 }),
            ],
          }),
        }),
      );

      expect(result.transactions[0].action).toBe(InvestmentAction.ADD_SHARES);
      expect(result.warnings).toEqual([]);
    });

    it("pairs each removal only once", () => {
      const result = mapInvestments(
        input({
          accounts: accountsFixture([10, 20, 30]),
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, account: 20, action: MNY_ACTION.ADD_SHARES }),
              invRow({ handle: 2, account: 30, action: MNY_ACTION.ADD_SHARES }),
              invRow({
                handle: 3,
                account: 10,
                action: MNY_ACTION.REMOVE_SHARES,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [1, 2, 3].map((transaction) =>
              mnyInvestmentDetail({ transaction, quantity: 7 }),
            ),
          }),
        }),
      );

      expect(result.transfersPaired).toBe(1);
      expect(
        result.transactions.filter(
          (t) => t.action === InvestmentAction.ADD_SHARES,
        ),
      ).toHaveLength(1);
    });
  });

  describe("SEC_SPLIT", () => {
    // Ignoring stock splits leaves every post-split position wrong by the ratio.
    it("creates a SPLIT row for each account holding the security", () => {
      const result = mapInvestments(
        input({
          accounts: accountsFixture([10, 20]),
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                account: 10,
                action: MNY_ACTION.BUY,
                date: "2026-01-01",
              }),
              invRow({
                handle: 2,
                account: 20,
                action: MNY_ACTION.BUY,
                date: "2026-01-02",
              }),
            ],
          }),
          investments: investmentData({
            securitySplits: [
              mnySecuritySplit({
                handle: 5,
                sharesBefore: 1,
                sharesAfter: 3,
                recordDate: "2026-02-01",
              }),
            ],
            prices: [mnySecurityPrice({ security: 1, split: 5 })],
            investmentDetails: [
              mnyInvestmentDetail({ transaction: 1, quantity: 10, price: 30 }),
              mnyInvestmentDetail({ transaction: 2, quantity: 5, price: 30 }),
            ],
          }),
        }),
      );

      const splits = result.transactions.filter(
        (t) => t.action === InvestmentAction.SPLIT,
      );
      expect(splits).toHaveLength(2);
      expect(splits.map((s) => s.accountKey).sort()).toEqual([
        "acct-10",
        "acct-20",
      ]);
      expect(splits[0]).toMatchObject({
        handle: null,
        quantity: 3,
        totalAmount: 0,
        cashAmount: 0,
        transactionDate: "2026-02-01",
      });
      expect(result.splitsApplied).toBe(2);
    });

    it("ignores accounts that only bought after the record date", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, date: "2026-06-01" }),
            ],
          }),
          investments: investmentData({
            securitySplits: [
              mnySecuritySplit({ handle: 5, recordDate: "2026-02-01" }),
            ],
            prices: [mnySecurityPrice({ security: 1, split: 5 })],
          }),
        }),
      );

      expect(result.splitsApplied).toBe(0);
    });

    it("orders a split after the same day's trades", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, date: "2026-02-01" }),
            ],
          }),
          investments: investmentData({
            securitySplits: [
              mnySecuritySplit({ handle: 5, recordDate: "2026-02-01" }),
            ],
            prices: [mnySecurityPrice({ security: 1, split: 5 })],
          }),
        }),
      );

      expect(result.transactions.map((t) => t.action)).toEqual([
        InvestmentAction.BUY,
        InvestmentAction.SPLIT,
      ]);
    });

    it("warns when no price row resolves the split to a security", () => {
      const result = mapInvestments(
        input({
          investments: investmentData({
            securitySplits: [mnySecuritySplit({ handle: 5 })],
          }),
        }),
      );

      expect(result.splitsApplied).toBe(0);
      expect(result.warnings).toEqual([
        {
          code: "unusableSecuritySplit",
          subject: "hss=5",
          detail: "no security",
        },
      ]);
    });

    it("warns on an unusable ratio instead of dividing by zero", () => {
      const result = mapInvestments(
        input({
          investments: investmentData({
            securitySplits: [
              mnySecuritySplit({ handle: 5, sharesBefore: 0, sharesAfter: 2 }),
            ],
            prices: [mnySecurityPrice({ security: 1, split: 5 })],
          }),
        }),
      );

      expect(result.splitsApplied).toBe(0);
      expect(result.warnings[0]).toMatchObject({
        code: "unusableSecuritySplit",
        detail: "ratio 2/0",
      });
    });
  });

  describe("referenced entities", () => {
    it("reports the securities, payees and categories the rows use", () => {
      const result = mapInvestments(
        input({
          securities: securitiesFixture([1, 2]),
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.DIVIDEND,
                payee: 4,
                category: 9,
              }),
              invRow({ handle: 2, security: 2, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect([...result.referencedSecurities].sort()).toEqual([1, 2]);
      expect([...result.referencedPayees]).toEqual([4]);
      expect([...result.referencedCategories]).toEqual([9]);
    });
  });
});
