import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  mnyBill,
  mnySplit,
  mnyTransaction,
  mnyTransfer,
  transactionData,
} from "../__fixtures__/mny-row-builders";
import { MNY_TRANSACTION_FLAG } from "../model/mny-model";
import { MapTransactionsInput, mapTransactions } from "./map-transactions";

/** Two ordinary accounts plus a loan account, all included in the import. */
const ACCOUNTS = new Map([
  [1, "acct-1"],
  [2, "acct-2"],
  [9, "acct-9"],
]);
const CURRENCIES = new Map([
  [1, "USD"],
  [2, "USD"],
  [9, "USD"],
]);

/**
 * `grftt` on a real loan payment: 0x80 (the row is in a debt account) plus the
 * transfer bits. Every one of the 1,239 loan and mortgage rows in the
 * maintainer's file carries 0x80, and reading it as the void flag imported all
 * of them VOID -- which then kept them out of the balance, freezing every loan
 * at its opening balance.
 */
const LOAN_PAYMENT_FLAGS = MNY_TRANSACTION_FLAG.DEBT_ACCOUNT | 0x6;

function input(
  overrides: Partial<MapTransactionsInput> = {},
): MapTransactionsInput {
  return {
    transactions: transactionData(),
    accountKeyByHandle: ACCOUNTS,
    currencyByHandle: CURRENCIES,
    bills: [],
    ...overrides,
  };
}

describe("mapTransactions", () => {
  describe("the phantom filter", () => {
    it("imports a scheduler-posted row -- the PR #192 loan regression", () => {
      // Money marks every scheduler-posted row, loan payments included.
      // Excluding them is what made loan accounts import empty.
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({
                handle: 1,
                amount: -500,
                flags: LOAN_PAYMENT_FLAGS,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].amount).toBe(-500);
      expect(result.transactions[0].status).toBe(
        TransactionStatus.UNRECONCILED,
      );
    });

    it("excludes a recurrence template (frq != -1)", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [mnyTransaction({ handle: 1, frequency: 3 })],
          }),
        }),
      );

      expect(result.transactions).toEqual([]);
      expect(result.skipped).toBe(0);
    });

    it("excludes a bill's template transaction", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1 }),
              mnyTransaction({ handle: 2 }),
            ],
          }),
          bills: [mnyBill({ handle: 1, templateTransaction: 2 })],
        }),
      );

      expect(result.transactions.map((t) => t.handle)).toEqual([1]);
    });

    it("excludes a split child from the top level", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, amount: -100 }),
              mnyTransaction({ handle: 2, amount: -100, category: 50 }),
            ],
            splits: [mnySplit({ parent: 1, child: 2 })],
          }),
        }),
      );

      expect(result.transactions.map((t) => t.handle)).toEqual([1]);
    });

    it("defers a row carrying a security to the investment mapper", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, security: 57, action: 0 }),
              mnyTransaction({ handle: 2 }),
            ],
          }),
        }),
      );

      expect(result.transactions.map((t) => t.handle)).toEqual([2]);
      expect(result.deferredInvestments).toBe(1);
      expect(result.warnings).toEqual([]);
    });

    it("skips a row with no account and reports it", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [mnyTransaction({ handle: 1, account: null })],
          }),
        }),
      );

      expect(result.transactions).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([
        {
          code: "unusableTransaction",
          subject: "htrn=1",
          detail: "no account",
          row: expect.objectContaining({ handle: 1 }),
        },
      ]);
    });

    it("skips a row whose date did not survive normalization", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [mnyTransaction({ handle: 1, date: null })],
          }),
        }),
      );

      expect(result.skipped).toBe(1);
      expect(result.warnings[0].detail).toBe("no usable date");
    });

    it("says nothing about a row in an account the user left out", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [mnyTransaction({ handle: 1, account: 77 })],
          }),
        }),
      );

      expect(result.transactions).toEqual([]);
      expect(result.skipped).toBe(0);
      expect(result.warnings).toEqual([]);
    });
  });

  describe("statuses", () => {
    it.each([
      [0, TransactionStatus.UNRECONCILED],
      [1, TransactionStatus.CLEARED],
      [2, TransactionStatus.RECONCILED],
    ])("maps cs=%i to %s", (cs, expected) => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [mnyTransaction({ handle: 1, clearedStatus: cs })],
          }),
        }),
      );

      expect(result.transactions[0].status).toBe(expected);
    });

    it("imports a voided row as VOID rather than dropping it", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({
                handle: 1,
                clearedStatus: 2,
                flags: MNY_TRANSACTION_FLAG.VOID,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0].status).toBe(TransactionStatus.VOID);
    });
  });

  describe("field mapping", () => {
    it("carries date, amount, memo, reference and currency across", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({
                handle: 1,
                account: 2,
                date: "2019-04-02",
                amount: -42.5,
                memo: "Groceries",
                reference: "1042",
                payee: 30,
                category: 40,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        accountKey: "acct-2",
        transactionDate: "2019-04-02",
        amount: -42.5,
        description: "Groceries",
        referenceNumber: "1042",
        payeeHandle: 30,
        categoryHandle: 40,
        currencyCode: "USD",
      });
    });

    it("gives every transaction a distinct pre-generated id", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1 }),
              mnyTransaction({ handle: 2 }),
              mnyTransaction({ handle: 3 }),
            ],
          }),
        }),
      );

      const ids = result.transactions.map((t) => t.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    });

    it("collects the payees and categories actually referenced", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, payee: 10, category: 20 }),
              mnyTransaction({ handle: 2, payee: null, category: 21 }),
              // Excluded, so its references must not count.
              mnyTransaction({ handle: 3, frequency: 3, payee: 99 }),
            ],
          }),
        }),
      );

      expect([...result.referencedPayees]).toEqual([10]);
      expect([...result.referencedCategories].sort()).toEqual([20, 21]);
    });
  });

  describe("plain transfers", () => {
    const pair = () =>
      transactionData({
        transactions: [
          mnyTransaction({ handle: 1, account: 1, amount: -250 }),
          mnyTransaction({ handle: 2, account: 2, amount: 250 }),
        ],
        transfers: [mnyTransfer({ from: 1, to: 2 })],
      });

    it("cross-links both sides by exact id, never by name and amount", () => {
      const result = mapTransactions(input({ transactions: pair() }));
      const [from, to] = result.transactions;

      expect(from.isTransfer).toBe(true);
      expect(to.isTransfer).toBe(true);
      expect(from.linkedTransactionId).toBe(to.id);
      expect(to.linkedTransactionId).toBe(from.id);
      expect(result.transfersLinked).toBe(1);
    });

    it("keeps each side's own amount, so a cross-currency pair survives", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, account: 1, amount: -100 }),
              mnyTransaction({ handle: 2, account: 2, amount: 78.4 }),
            ],
            transfers: [mnyTransfer({ from: 1, to: 2 })],
          }),
          currencyByHandle: new Map([
            [1, "USD"],
            [2, "GBP"],
          ]),
        }),
      );

      expect(result.transactions.map((t) => t.amount)).toEqual([-100, 78.4]);
      expect(result.transactions.map((t) => t.currencyCode)).toEqual([
        "USD",
        "GBP",
      ]);
    });

    it("imports a side whose counterpart account was left out as a plain row", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, account: 1, amount: -250 }),
              mnyTransaction({ handle: 2, account: 77, amount: 250 }),
            ],
            transfers: [mnyTransfer({ from: 1, to: 2 })],
          }),
        }),
      );

      // Dropping it would silently remove real money from an account the user
      // did import.
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].isTransfer).toBe(false);
      expect(result.warnings).toEqual([
        {
          code: "transferAcrossExcludedAccount",
          subject: "htrn=1",
          detail: "partner htrn=2",
          row: expect.objectContaining({ handle: 1 }),
        },
      ]);
    });

    it("drops a genuinely orphaned side whose counterpart is not in the file", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [mnyTransaction({ handle: 1, account: 1 })],
            transfers: [mnyTransfer({ from: 1, to: 999 })],
          }),
        }),
      );

      expect(result.transactions).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([
        {
          code: "orphanedTransferSide",
          subject: "htrn=1",
          row: expect.objectContaining({ handle: 1 }),
        },
      ]);
    });
  });

  describe("splits", () => {
    it("maps category legs from the child rows", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, amount: -100, category: 5 }),
              mnyTransaction({
                handle: 2,
                amount: -70,
                category: 51,
                memo: "Food",
              }),
              mnyTransaction({
                handle: 3,
                amount: -30,
                category: 52,
                memo: "Household",
              }),
            ],
            splits: [
              mnySplit({ parent: 1, child: 3, position: 1 }),
              mnySplit({ parent: 1, child: 2, position: 0 }),
            ],
          }),
        }),
      );

      const [parent] = result.transactions;
      expect(parent.splits).toEqual([
        {
          kind: SplitKind.CATEGORY,
          categoryHandle: 51,
          transferAccountKey: null,
          linkedTransactionId: null,
          amount: -70,
          memo: "Food",
        },
        {
          kind: SplitKind.CATEGORY,
          categoryHandle: 52,
          transferAccountKey: null,
          linkedTransactionId: null,
          amount: -30,
          memo: "Household",
        },
      ]);
    });

    it("clears the parent's own category, since the legs carry them", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, amount: -100, category: 5 }),
              mnyTransaction({ handle: 2, amount: -100, category: 51 }),
            ],
            splits: [mnySplit({ parent: 1, child: 2 })],
          }),
        }),
      );

      expect(result.transactions[0].categoryHandle).toBeNull();
      expect([...result.referencedCategories]).toEqual([51]);
    });

    it("warns when the legs do not add up to the total", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, amount: -100 }),
              mnyTransaction({ handle: 2, amount: -70, category: 51 }),
            ],
            splits: [mnySplit({ parent: 1, child: 2 })],
          }),
        }),
      );

      expect(result.warnings).toEqual([
        {
          code: "splitSumMismatch",
          subject: "htrn=1",
          detail: "legs -70 vs total -100",
          row: expect.objectContaining({ handle: 1 }),
        },
      ]);
    });

    it("carries the flagged transaction, not only its handle", () => {
      // The review step expands this into a list the user takes back to Money
      // to fix. `htrn=1` cannot be searched for there; a date, an account, a
      // payee and an amount can.
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({
                handle: 1,
                amount: -100,
                date: "2001-04-30",
                payee: 30,
                reference: "1042",
                memo: "Payroll",
              }),
              mnyTransaction({ handle: 2, amount: -70, category: 51 }),
            ],
            splits: [mnySplit({ parent: 1, child: 2 })],
          }),
        }),
      );

      expect(result.warnings[0].row).toEqual({
        handle: 1,
        accountKey: "acct-1",
        date: "2001-04-30",
        amount: -100,
        payeeHandle: 30,
        reference: "1042",
        memo: "Payroll",
      });
    });

    it("reports a leg whose parent is not in the file", () => {
      const result = mapTransactions(
        input({
          transactions: transactionData({
            transactions: [mnyTransaction({ handle: 2, amount: -70 })],
            splits: [mnySplit({ parent: 1, child: 2 })],
          }),
        }),
      );

      expect(result.transactions).toEqual([]);
      expect(result.warnings).toEqual([
        {
          code: "orphanedSplit",
          subject: "htrn=2",
          detail: "parent htrn=1",
          row: expect.objectContaining({ handle: 2 }),
        },
      ]);
    });
  });

  describe("the loan payment", () => {
    /**
     * The scenario from PR #192 issue 1: a mortgage payment in the chequing
     * account, split into a principal leg that is really a transfer to the loan
     * account and an interest leg that is an ordinary expense. Money records the
     * principal leg in `TRN_XFER` against the loan-side row.
     */
    function loanPayment() {
      return transactionData({
        transactions: [
          // The payment, in chequing.
          mnyTransaction({
            handle: 1,
            account: 1,
            amount: -1500,
            payee: 30,
            clearedStatus: 2,
          }),
          // Principal leg.
          mnyTransaction({ handle: 2, account: 1, amount: -400 }),
          // Interest leg.
          mnyTransaction({
            handle: 3,
            account: 1,
            amount: -1100,
            category: 60,
            memo: "Interest",
          }),
          // The loan-side row Money posts against the mortgage account. It
          // carries 0x80 because it lives in a debt account -- the bit PR #192
          // read as "voided".
          mnyTransaction({
            handle: 4,
            account: 9,
            amount: 400,
            clearedStatus: 2,
            flags: LOAN_PAYMENT_FLAGS,
          }),
        ],
        splits: [
          mnySplit({ parent: 1, child: 2, position: 0 }),
          mnySplit({ parent: 1, child: 3, position: 1 }),
        ],
        transfers: [mnyTransfer({ from: 2, to: 4 })],
      });
    }

    it("makes the principal leg a transfer split to the loan account", () => {
      const result = mapTransactions(input({ transactions: loanPayment() }));
      const payment = result.transactions.find((t) => t.handle === 1)!;
      const [principal, interest] = payment.splits;

      expect(principal).toMatchObject({
        kind: SplitKind.TRANSFER,
        transferAccountKey: "acct-9",
        categoryHandle: null,
        amount: -400,
      });
      expect(interest).toMatchObject({
        kind: SplitKind.CATEGORY,
        categoryHandle: 60,
        amount: -1100,
      });
    });

    it("links the split to the loan-side transaction, imported exactly once", () => {
      const result = mapTransactions(input({ transactions: loanPayment() }));
      const payment = result.transactions.find((t) => t.handle === 1)!;
      const loanSide = result.transactions.filter((t) => t.handle === 4);

      expect(loanSide).toHaveLength(1);
      expect(payment.splits[0].linkedTransactionId).toBe(loanSide[0].id);
    });

    it("points the loan-side row back at the parent payment, not at the leg", () => {
      // This is the wiring TransactionSplitService produces: the far side of a
      // transfer split links to the parent transaction.
      const result = mapTransactions(input({ transactions: loanPayment() }));
      const payment = result.transactions.find((t) => t.handle === 1)!;
      const loanSide = result.transactions.find((t) => t.handle === 4)!;

      expect(loanSide.isTransfer).toBe(true);
      expect(loanSide.linkedTransactionId).toBe(payment.id);
    });

    it("does not mark the split parent itself a transfer", () => {
      const result = mapTransactions(input({ transactions: loanPayment() }));
      const payment = result.transactions.find((t) => t.handle === 1)!;

      expect(payment.isTransfer).toBe(false);
      expect(payment.linkedTransactionId).toBeNull();
    });

    it("counts the transfer split once", () => {
      const result = mapTransactions(input({ transactions: loanPayment() }));

      expect(result.transfersLinked).toBe(1);
    });

    it("imports neither side as VOID", () => {
      // The reported bug: "all loan payments are being imported as VOID".
      // 0x80 marks a row in a debt account, not a voided one, so both sides
      // keep the reconciliation state Money gave them.
      const result = mapTransactions(input({ transactions: loanPayment() }));

      expect(result.transactions.map((t) => t.status)).not.toContain(
        TransactionStatus.VOID,
      );
      expect(result.transactions.find((t) => t.handle === 4)!.status).toBe(
        TransactionStatus.RECONCILED,
      );
    });

    it("keeps the principal leg as a category split when the loan account is left out", () => {
      const result = mapTransactions(
        input({
          transactions: loanPayment(),
          accountKeyByHandle: new Map([[1, "acct-1"]]),
        }),
      );
      const payment = result.transactions.find((t) => t.handle === 1)!;

      expect(payment.splits[0].kind).toBe(SplitKind.CATEGORY);
      expect(payment.splits.map((s) => s.amount)).toEqual([-400, -1100]);
      expect(result.warnings.map((w) => w.code)).toContain(
        "transferAcrossExcludedAccount",
      );
    });
  });
});
