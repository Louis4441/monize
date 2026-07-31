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
  isCurrencyPseudoSecurity,
  isCurrencyQuoteSymbol,
  isDebtAccountRow,
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

  it("does not treat a loan payment as voided", () => {
    // 0x86 is the flag word every loan and mortgage payment in the
    // maintainer's file carries: 0x80 (debt account) | 0x4 | 0x2 (transfer
    // side). Reading 0x80 as void made all 1,084 of them import VOID, which
    // then excluded them from the balance, so every loan sat at its opening
    // balance forever.
    const loanPayment = 0x86;

    expect(isDebtAccountRow(loanPayment)).toBe(true);
    expect(isVoided(loanPayment)).toBe(false);
    expect(
      mapTransactionStatus(MNY_CLEARED_STATUS.RECONCILED, loanPayment),
    ).toBe(TransactionStatus.RECONCILED);
  });

  it("reads void and debt-account out of a combined word", () => {
    const flags =
      MNY_TRANSACTION_FLAG.VOID | MNY_TRANSACTION_FLAG.DEBT_ACCOUNT | 0x12;

    expect(isVoided(flags)).toBe(true);
    expect(isDebtAccountRow(flags)).toBe(true);
  });

  it("treats every observed non-void flag word as not voided", () => {
    // Every distinct grftt bit the maintainer's Money Plus file carries, minus
    // the void bit itself: transfer sides, investment rows, split parents and
    // children, debt-account rows and scheduled-series members. None is void.
    for (const flags of [
      0x2, 0x4, 0x6, 0x10, 0x12, 0x16, 0x20, 0x40, 0x42, 0x46, 0x80, 0x86, 0xa0,
      0xc0, 0x4086, 0x200016, 0x200086, 0x240016,
    ]) {
      expect(isVoided(flags)).toBe(false);
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
    [MNY_ACTION.BUY_LEGACY, InvestmentAction.BUY],
    [MNY_ACTION.BUY, InvestmentAction.BUY],
    [MNY_ACTION.SELL, InvestmentAction.SELL],
    [MNY_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
    [MNY_ACTION.DISTRIBUTION, InvestmentAction.DIVIDEND],
    [MNY_ACTION.REINVEST, InvestmentAction.REINVEST],
    [MNY_ACTION.BUY_ALT, InvestmentAction.BUY],
    [MNY_ACTION.REINVEST_ALT, InvestmentAction.REINVEST],
    [MNY_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
    [MNY_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
    [MNY_ACTION.TRANSFER_IN, InvestmentAction.TRANSFER_IN],
    [MNY_ACTION.TRANSFER_OUT, InvestmentAction.TRANSFER_OUT],
  ])("maps act %p to %s", (act, expected) => {
    expect(mapInvestmentAction(act)).toBe(expected);
  });

  it("maps act 16 to REMOVE_SHARES, never SELL", () => {
    // Mapping it to SELL closes lots against a fabricated sale price and
    // corrupts average cost -- PR #192 issue 4.
    expect(mapInvestmentAction(MNY_ACTION.REMOVE_SHARES_LEGACY)).toBe(
      InvestmentAction.REMOVE_SHARES,
    );
    expect(mapInvestmentAction(MNY_ACTION.REMOVE_SHARES_LEGACY)).not.toBe(
      InvestmentAction.SELL,
    );
  });

  it.each([[6], [10], [17], [18], [20], [99]])(
    "returns null for the unknown act %p",
    (act) => {
      // 10, 17, 18 and 20 all occur in real Money Plus files but open and
      // close no lot, so nothing says what they do to a position. They are
      // skipped and warned about rather than guessed at.
      expect(mapInvestmentAction(act)).toBeNull();
    },
  );

  it("maps act 1 to BUY, never SELL", () => {
    // The defect this guards: PR #192's format reference had act 1 as SELL.
    // LOT disagrees -- act 1 opens 3,520 lots in the maintainer's file and
    // closes none -- so every purchase imported as a sale, no cash ever left
    // a brokerage sleeve, and holdings replayed negative.
    expect(mapInvestmentAction(MNY_ACTION.BUY)).toBe(InvestmentAction.BUY);
    expect(mapInvestmentAction(MNY_ACTION.BUY)).not.toBe(InvestmentAction.SELL);
  });

  it("maps the codes LOT proves acquire shares onto acquisitions", () => {
    // Whatever act a LOT.htrnBuy row carries opens a position, by definition.
    for (const act of [
      MNY_ACTION.BUY,
      MNY_ACTION.REINVEST,
      MNY_ACTION.BUY_ALT,
      MNY_ACTION.TRANSFER_IN,
    ]) {
      expect(mapInvestmentAction(act)).not.toBeNull();
      expect([
        InvestmentAction.BUY,
        InvestmentAction.REINVEST,
        InvestmentAction.TRANSFER_IN,
        InvestmentAction.ADD_SHARES,
      ]).toContain(mapInvestmentAction(act));
    }
  });

  it("maps the codes LOT proves dispose of shares onto disposals", () => {
    for (const act of [
      MNY_ACTION.SELL,
      MNY_ACTION.REMOVE_SHARES,
      MNY_ACTION.TRANSFER_OUT,
    ]) {
      expect([
        InvestmentAction.SELL,
        InvestmentAction.REMOVE_SHARES,
        InvestmentAction.TRANSFER_OUT,
      ]).toContain(mapInvestmentAction(act));
    }
  });

  it("flags the inferred action codes so mappers can warn", () => {
    expect([...MNY_UNCONFIRMED_ACTIONS].sort((a, b) => a - b)).toEqual([
      MNY_ACTION.DISTRIBUTION,
      MNY_ACTION.REINVEST_ALT,
      MNY_ACTION.BUY_ALT,
      MNY_ACTION.CAPITAL_GAIN,
    ]);
  });

  it("knows that dividends carry no TRN_INV row", () => {
    // Iterating TRN_INV instead of TRN drops every cash dividend.
    expect(hasInvestmentDetail(MNY_ACTION.DIVIDEND)).toBe(false);
    expect(hasInvestmentDetail(MNY_ACTION.DISTRIBUTION)).toBe(false);
    expect(hasInvestmentDetail(MNY_ACTION.BUY)).toBe(true);
    expect(hasInvestmentDetail(MNY_ACTION.SELL)).toBe(true);
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
    [MNY_FREQUENCY.EVERY_2_MONTHS, FrequencyType.EVERY2MONTHS],
    [MNY_FREQUENCY.QUARTERLY, FrequencyType.QUARTERLY],
    [MNY_FREQUENCY.SEMIANNUAL, FrequencyType.SEMIANNUAL],
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
    [2, FrequencyType.EVERY2MONTHS],
    [3, FrequencyType.QUARTERLY],
    [6, FrequencyType.SEMIANNUAL],
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

  it("maps every-two-months exactly, by code and by interval", () => {
    // PR #192 mapped this to BIWEEKLY -- every two weeks, not every two
    // months. Before task B3 Monize had no type for it and the mapper
    // downgraded to MONTHLY with a warning.
    const expected = {
      frequency: FrequencyType.EVERY2MONTHS,
      approximate: false,
    };
    expect(mapFrequency(MNY_FREQUENCY.EVERY_2_MONTHS)).toEqual(expected);
    expect(mapFrequency(MNY_FREQUENCY.MONTHLY, 2)).toEqual(expected);
  });

  it("maps semiannual exactly, by code and by interval", () => {
    // PR #192 stretched it to YEARLY, halving the reminders; before B3 the
    // mapper downgraded to QUARTERLY with a warning.
    const expected = {
      frequency: FrequencyType.SEMIANNUAL,
      approximate: false,
    };
    expect(mapFrequency(MNY_FREQUENCY.SEMIANNUAL)).toEqual(expected);
    expect(mapFrequency(MNY_FREQUENCY.MONTHLY, 6)).toEqual(expected);
  });

  it("approximates an unrepresentable weekly interval", () => {
    expect(mapFrequency(MNY_FREQUENCY.WEEKLY, 3)).toEqual({
      frequency: FrequencyType.WEEKLY,
      approximate: true,
    });
  });

  it("approximates an unrepresentable monthly interval", () => {
    expect(mapFrequency(MNY_FREQUENCY.MONTHLY, 5)).toEqual({
      frequency: FrequencyType.MONTHLY,
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
