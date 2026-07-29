import { AccountType } from "../../../accounts/entities/account.entity";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  MNY_FIXTURES,
  MnyFixtureName,
  readMnyFixture,
} from "../__fixtures__/mny-fixtures";
import { openMnyFile } from "../msisam/open-mny";
import { readMnyTables } from "../tables/read-mny-tables";
import {
  MNY_ACCOUNT_TYPE,
  MNY_ACTION,
  MNY_CATEGORY_TYPE,
  MNY_CLEARED_STATUS,
  MNY_FREQUENCY,
  MNY_REAL_POSTING_FREQUENCY,
  MNY_TRANSACTION_FLAG,
  MNY_UNCONFIRMED_ACTIONS,
  hasInvestmentDetail,
  isAutoEntered,
  isCurrencyPseudoSecurity,
  isCurrencyQuoteSymbol,
  isIncomeCategoryType,
  isRecurrenceTemplate,
  isVoided,
  mapAccountType,
  mapFrequency,
  mapInvestmentAction,
  mapTransactionStatus,
} from "./mny-model";

const ALL_FIXTURES = Object.keys(MNY_FIXTURES) as MnyFixtureName[];

function tablesOf(fixture: MnyFixtureName) {
  return readMnyTables(
    openMnyFile(readMnyFixture(fixture), MNY_FIXTURES[fixture].password),
  );
}

describe("mapAccountType", () => {
  it.each([
    [MNY_ACCOUNT_TYPE.BANK, AccountType.CHEQUING],
    [MNY_ACCOUNT_TYPE.CREDIT_CARD, AccountType.CREDIT_CARD],
    [MNY_ACCOUNT_TYPE.CASH, AccountType.CASH],
    [MNY_ACCOUNT_TYPE.ASSET, AccountType.ASSET],
    [MNY_ACCOUNT_TYPE.LOAN, AccountType.LOAN],
    [MNY_ACCOUNT_TYPE.INVESTMENT, AccountType.INVESTMENT],
    [MNY_ACCOUNT_TYPE.MORTGAGE, AccountType.MORTGAGE],
  ])("maps at %p to %s", (at, expected) => {
    expect(mapAccountType(at)).toBe(expected);
  });

  it.each([[-1], [7], [99]])("returns null for the unknown code %p", (at) => {
    expect(mapAccountType(at)).toBeNull();
  });
});

describe("transaction status", () => {
  it.each([
    [MNY_CLEARED_STATUS.UNRECONCILED, TransactionStatus.UNRECONCILED],
    [MNY_CLEARED_STATUS.CLEARED, TransactionStatus.CLEARED],
    [MNY_CLEARED_STATUS.RECONCILED, TransactionStatus.RECONCILED],
  ])("maps cs %p to %s", (cs, expected) => {
    expect(mapTransactionStatus(cs, 0)).toBe(expected);
  });

  it("falls back to unreconciled for an unknown cs", () => {
    // Safer direction: a wrongly-reconciled row hides a real discrepancy.
    expect(mapTransactionStatus(9, 0)).toBe(TransactionStatus.UNRECONCILED);
  });

  it("lets the void flag win over the reconciliation state", () => {
    expect(
      mapTransactionStatus(
        MNY_CLEARED_STATUS.RECONCILED,
        MNY_TRANSACTION_FLAG.VOID,
      ),
    ).toBe(TransactionStatus.VOID);
  });

  it("does not treat an auto-entered row as voided", () => {
    // PR #192 excluded auto-entered rows, which emptied every loan account.
    const flags = MNY_TRANSACTION_FLAG.AUTO_ENTERED;

    expect(isAutoEntered(flags)).toBe(true);
    expect(isVoided(flags)).toBe(false);
    expect(mapTransactionStatus(MNY_CLEARED_STATUS.CLEARED, flags)).toBe(
      TransactionStatus.CLEARED,
    );
  });

  it("reads both flags out of a combined word", () => {
    const flags =
      MNY_TRANSACTION_FLAG.VOID | MNY_TRANSACTION_FLAG.AUTO_ENTERED | 0x12;

    expect(isVoided(flags)).toBe(true);
    expect(isAutoEntered(flags)).toBe(true);
  });

  it("treats the fixture flag words as neither voided nor auto-entered", () => {
    // money2001/2002 rows carry 0x2, Money Plus rows 0x10.
    for (const flags of [0x2, 0x10]) {
      expect(isVoided(flags)).toBe(false);
      expect(isAutoEntered(flags)).toBe(false);
    }
  });
});

describe("isRecurrenceTemplate", () => {
  it("treats frq -1 as a real posting", () => {
    expect(isRecurrenceTemplate(MNY_REAL_POSTING_FREQUENCY)).toBe(false);
  });

  it.each([[0], [3], [12]])("treats frq %p as a template", (frequency) => {
    expect(isRecurrenceTemplate(frequency)).toBe(true);
  });
});

describe("mapInvestmentAction", () => {
  it.each([
    [MNY_ACTION.BUY, InvestmentAction.BUY],
    [MNY_ACTION.SELL, InvestmentAction.SELL],
    [MNY_ACTION.REINVEST, InvestmentAction.REINVEST],
    [MNY_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
    [MNY_ACTION.REINVEST_ALT, InvestmentAction.REINVEST],
    [MNY_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
    [MNY_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
  ])("maps act %p to %s", (act, expected) => {
    expect(mapInvestmentAction(act)).toBe(expected);
  });

  it("maps act 16 to REMOVE_SHARES, never SELL", () => {
    // Mapping it to SELL closes lots against a fabricated sale price and
    // corrupts average cost -- PR #192 issue 4.
    expect(mapInvestmentAction(MNY_ACTION.REMOVE_SHARES)).toBe(
      InvestmentAction.REMOVE_SHARES,
    );
    expect(mapInvestmentAction(MNY_ACTION.REMOVE_SHARES)).not.toBe(
      InvestmentAction.SELL,
    );
  });

  it.each([[2], [6], [99]])("returns null for the unknown act %p", (act) => {
    expect(mapInvestmentAction(act)).toBeNull();
  });

  it("flags the inferred action codes so mappers can warn", () => {
    expect([...MNY_UNCONFIRMED_ACTIONS].sort((a, b) => a - b)).toEqual([
      MNY_ACTION.REINVEST_ALT,
      MNY_ACTION.CAPITAL_GAIN,
    ]);
  });

  it("knows that dividends carry no TRN_INV row", () => {
    // Iterating TRN_INV instead of TRN drops every cash dividend.
    expect(hasInvestmentDetail(MNY_ACTION.DIVIDEND)).toBe(false);
    expect(hasInvestmentDetail(MNY_ACTION.BUY)).toBe(true);
  });
});

describe("currency pseudo-securities", () => {
  it.each([["/GBPUS"], ["/ARSUS"], ["/AUDUS"]])(
    "recognises the currency quote symbol %s",
    (symbol) => {
      expect(isCurrencyQuoteSymbol(symbol)).toBe(true);
    },
  );

  it.each([["VOO"], ["$US:INDU"], ["/GBP"], [""], ["/gbpus"]])(
    "does not mistake %p for a currency",
    (symbol) => {
      expect(isCurrencyQuoteSymbol(symbol)).toBe(false);
    },
  );

  it("excludes a row by either the type code or the symbol shape", () => {
    // sct codes shift between releases, so the symbol shape is the
    // version-independent half of the test.
    expect(isCurrencyPseudoSecurity(4, "anything")).toBe(true);
    expect(isCurrencyPseudoSecurity(6, "/GBPUS")).toBe(true);
    expect(isCurrencyPseudoSecurity(6, "$XAL.X")).toBe(false);
  });

  it("matches every currency quote symbol in every fixture", () => {
    for (const fixture of ALL_FIXTURES) {
      const { currencies } = tablesOf(fixture).reference;
      const quoted = currencies.filter(
        (currency) => currency.quoteSymbol !== "",
      );

      expect(quoted.length).toBeGreaterThan(40);
      expect(
        quoted.every((currency) => isCurrencyQuoteSymbol(currency.quoteSymbol)),
      ).toBe(true);
    }
  });

  it("keeps every real security in the fixtures", () => {
    // No fixture contains a currency pseudo-security, so the exclusion must
    // not fire at all here.
    for (const fixture of ALL_FIXTURES) {
      const { securities } = tablesOf(fixture).investments;

      expect(
        securities.some((security) =>
          isCurrencyPseudoSecurity(security.securityType, security.symbol),
        ),
      ).toBe(false);
    }
  });
});

describe("isIncomeCategoryType", () => {
  it.each([
    [MNY_CATEGORY_TYPE.INCOME, true],
    [MNY_CATEGORY_TYPE.INCOME_ALT, true],
    [MNY_CATEGORY_TYPE.EXPENSE, false],
    [MNY_CATEGORY_TYPE.EXPENSE_ALT, false],
  ])("classifies lType %p as income=%p", (categoryType, expected) => {
    expect(isIncomeCategoryType(categoryType)).toBe(expected);
  });

  it.each([[MNY_CATEGORY_TYPE.ROOT], [7]])(
    "returns null for lType %p so the caller walks to the root",
    (categoryType) => {
      expect(isIncomeCategoryType(categoryType)).toBeNull();
    },
  );

  it("agrees with the root ancestor for every category in every fixture", () => {
    // The evidence behind the constant: 349 categories across three Money
    // vintages, no crossover between the lType groups and the two roots.
    let checked = 0;

    for (const fixture of ALL_FIXTURES) {
      const { categories } = tablesOf(fixture).reference;
      const byHandle = new Map(
        categories.map((category) => [category.handle, category]),
      );

      for (const category of categories) {
        let root = category;
        while (root.parent !== null && byHandle.has(root.parent)) {
          root = byHandle.get(root.parent)!;
        }

        const fromType = isIncomeCategoryType(category.categoryType);
        if (fromType !== null) {
          expect(fromType).toBe(root.name === "INCOME");
          checked++;
        } else {
          // Only the roots themselves are unclassifiable.
          expect(category.categoryType).toBe(MNY_CATEGORY_TYPE.ROOT);
        }
      }
    }

    expect(checked).toBeGreaterThan(300);
  });
});

describe("mapFrequency", () => {
  it.each([
    [MNY_FREQUENCY.ONCE, FrequencyType.ONCE],
    [MNY_FREQUENCY.DAILY, FrequencyType.DAILY],
    [MNY_FREQUENCY.WEEKLY, FrequencyType.WEEKLY],
    [MNY_FREQUENCY.MONTHLY, FrequencyType.MONTHLY],
    [MNY_FREQUENCY.YEARLY, FrequencyType.YEARLY],
    [MNY_FREQUENCY.QUARTERLY, FrequencyType.QUARTERLY],
  ])("maps frq %p to %s exactly", (frequency, expected) => {
    expect(mapFrequency(frequency)).toEqual({
      frequency: expected,
      approximate: false,
    });
  });

  it.each([
    [2, FrequencyType.BIWEEKLY],
    [4, FrequencyType.EVERY4WEEKS],
  ])(
    "turns a weekly recurrence every %p weeks into %s",
    (interval, expected) => {
      expect(mapFrequency(MNY_FREQUENCY.WEEKLY, interval)).toEqual({
        frequency: expected,
        approximate: false,
      });
    },
  );

  it.each([
    [3, FrequencyType.QUARTERLY],
    [12, FrequencyType.YEARLY],
  ])(
    "turns a monthly recurrence every %p months into %s",
    (interval, expected) => {
      expect(mapFrequency(MNY_FREQUENCY.MONTHLY, interval)).toEqual({
        frequency: expected,
        approximate: false,
      });
    },
  );

  it("marks every-two-months as an approximate monthly", () => {
    // PR #192 mapped this to BIWEEKLY -- every two weeks, not every two
    // months.
    expect(mapFrequency(MNY_FREQUENCY.EVERY_2_MONTHS)).toEqual({
      frequency: FrequencyType.MONTHLY,
      approximate: true,
    });
    expect(mapFrequency(MNY_FREQUENCY.MONTHLY, 2)).toEqual({
      frequency: FrequencyType.MONTHLY,
      approximate: true,
    });
  });

  it("marks semiannual as an approximate quarterly", () => {
    // PR #192 stretched it to YEARLY, halving the reminders.
    expect(mapFrequency(MNY_FREQUENCY.SEMIANNUAL)).toEqual({
      frequency: FrequencyType.QUARTERLY,
      approximate: true,
    });
    expect(mapFrequency(MNY_FREQUENCY.MONTHLY, 6)).toEqual({
      frequency: FrequencyType.MONTHLY,
      approximate: true,
    });
  });

  it("approximates an unrepresentable weekly interval", () => {
    expect(mapFrequency(MNY_FREQUENCY.WEEKLY, 3)).toEqual({
      frequency: FrequencyType.WEEKLY,
      approximate: true,
    });
  });

  it.each([[0], [-4], [Number.NaN]])(
    "treats the nonsensical interval %p as one",
    (interval) => {
      expect(mapFrequency(MNY_FREQUENCY.WEEKLY, interval)).toEqual({
        frequency: FrequencyType.WEEKLY,
        approximate: false,
      });
    },
  );

  it.each([[8], [-1], [99]])(
    "returns null for the unknown frq %p",
    (frequency) => {
      expect(mapFrequency(frequency)).toBeNull();
    },
  );
});
