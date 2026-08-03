import {
  HIDDEN_ACCOUNT_NAME,
  maskAutoPayeeName,
  maskTransactionsAgainst,
  payloadHasCrossOwnerTransfer,
} from "./transfer-mask.util";

describe("transfer-mask.util", () => {
  describe("maskAutoPayeeName", () => {
    it("rewrites the auto payee tail", () => {
      expect(maskAutoPayeeName("Transfer to Savings")).toBe(
        `Transfer to ${HIDDEN_ACCOUNT_NAME}`,
      );
      expect(maskAutoPayeeName("Transfer from Chequing")).toBe(
        `Transfer from ${HIDDEN_ACCOUNT_NAME}`,
      );
    });

    it("leaves custom payee names alone", () => {
      expect(maskAutoPayeeName("Rent settlement")).toBe("Rent settlement");
    });
  });

  describe("payloadHasCrossOwnerTransfer", () => {
    const crossRow = {
      userId: "u1",
      isTransfer: true,
      linkedTransaction: { userId: "u2", accountId: "a2" },
    };
    const sameRow = {
      userId: "u1",
      isTransfer: true,
      linkedTransaction: { userId: "u1", accountId: "a2" },
    };

    it("detects a cross-owner row in every payload shape", () => {
      expect(payloadHasCrossOwnerTransfer([crossRow])).toBe(true);
      expect(payloadHasCrossOwnerTransfer({ data: [sameRow, crossRow] })).toBe(
        true,
      );
      expect(payloadHasCrossOwnerTransfer(crossRow)).toBe(true);
    });

    it("stays false for same-owner rows, non-transfers, and scalars", () => {
      expect(payloadHasCrossOwnerTransfer([sameRow])).toBe(false);
      expect(payloadHasCrossOwnerTransfer({ data: [{ id: "x" }] })).toBe(false);
      expect(payloadHasCrossOwnerTransfer(null)).toBe(false);
      expect(payloadHasCrossOwnerTransfer("nope")).toBe(false);
      // A linked leg that does not expose userId cannot prove cross-owner.
      expect(
        payloadHasCrossOwnerTransfer({
          isTransfer: true,
          linkedTransaction: { accountId: "a2" },
        }),
      ).toBe(false);
    });
  });

  describe("maskTransactionsAgainst", () => {
    it("masks only unreadable counterparts, including accountName fields", () => {
      const rows = [
        {
          isTransfer: true,
          payeeName: "Transfer to Hidden Target",
          linkedTransaction: {
            accountId: "a2",
            account: { id: "a2", name: "Hidden Target", currentBalance: 10 },
            accountName: "Hidden Target",
          },
        },
        {
          isTransfer: true,
          payeeName: "Transfer to Visible",
          linkedTransaction: {
            accountId: "a3",
            account: { id: "a3", name: "Visible" },
          },
        },
      ];

      maskTransactionsAgainst(new Set(["a3"]), rows);

      expect(rows[0].linkedTransaction.account).toEqual({
        id: "a2",
        name: HIDDEN_ACCOUNT_NAME,
      });
      expect(rows[0].linkedTransaction.accountName).toBe(HIDDEN_ACCOUNT_NAME);
      expect(rows[0].payeeName).toBe(`Transfer to ${HIDDEN_ACCOUNT_NAME}`);
      expect(rows[1].linkedTransaction.account.name).toBe("Visible");
      expect(rows[1].payeeName).toBe("Transfer to Visible");
    });
  });
});
