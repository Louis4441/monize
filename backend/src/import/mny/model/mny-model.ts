import { AccountType } from "../../../accounts/entities/account.entity";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";

/**
 * Microsoft Money's coded values, and how they map onto Monize's domain.
 *
 * Every constant here is either **confirmed** against the committed fixtures
 * (see `mny-model.spec.ts`, which asserts the fixture evidence) or carried
 * over from PR #192's reverse-engineered format reference and marked
 * **unconfirmed**. Nothing is guessed silently: an unconfirmed code that turns
 * up in a real file must surface as a warning rather than a mapping.
 *
 * Mappers own the row-level rules (which rows are phantoms, how transfers
 * pair). This file owns only code-to-meaning lookups over a single value.
 */

// ---------------------------------------------------------------------------
// Accounts (`ACCT.at`)
// ---------------------------------------------------------------------------

/**
 * Money account types. **Unconfirmed beyond 0 and 5** -- the sample files only
 * contain investment accounts and their paired cash accounts. The rest come
 * from PR #192's format reference.
 */
export const MNY_ACCOUNT_TYPE = {
  BANK: 0,
  CREDIT_CARD: 1,
  CASH: 2,
  ASSET: 3,
  LOAN: 4,
  INVESTMENT: 5,
  MORTGAGE: 6,
} as const;

const ACCOUNT_TYPE_BY_CODE: ReadonlyMap<number, AccountType> = new Map([
  [MNY_ACCOUNT_TYPE.BANK, AccountType.CHEQUING],
  [MNY_ACCOUNT_TYPE.CREDIT_CARD, AccountType.CREDIT_CARD],
  [MNY_ACCOUNT_TYPE.CASH, AccountType.CASH],
  [MNY_ACCOUNT_TYPE.ASSET, AccountType.ASSET],
  [MNY_ACCOUNT_TYPE.LOAN, AccountType.LOAN],
  [MNY_ACCOUNT_TYPE.INVESTMENT, AccountType.INVESTMENT],
  [MNY_ACCOUNT_TYPE.MORTGAGE, AccountType.MORTGAGE],
]);

/**
 * The Monize account type for a Money `at` code, or null when the code is
 * unknown. Money has no separate savings type, so bank accounts land on
 * CHEQUING; the wizard lets the user change it.
 */
export function mapAccountType(at: number): AccountType | null {
  return ACCOUNT_TYPE_BY_CODE.get(at) ?? null;
}

// ---------------------------------------------------------------------------
// Transactions (`TRN.cs`, `TRN.grftt`, `TRN.frq`)
// ---------------------------------------------------------------------------

/** Reconciliation state. Confirmed: every fixture row is 0. */
export const MNY_CLEARED_STATUS = {
  UNRECONCILED: 0,
  CLEARED: 1,
  RECONCILED: 2,
} as const;

const STATUS_BY_CODE: ReadonlyMap<number, TransactionStatus> = new Map([
  [MNY_CLEARED_STATUS.UNRECONCILED, TransactionStatus.UNRECONCILED],
  [MNY_CLEARED_STATUS.CLEARED, TransactionStatus.CLEARED],
  [MNY_CLEARED_STATUS.RECONCILED, TransactionStatus.RECONCILED],
]);

/**
 * Bits of the `TRN.grftt` flag word.
 *
 * Every bit here is **measured** against the maintainer's Money Plus file
 * (53,079 `TRN` rows across 56 accounts) by cross-tabbing the bit against facts
 * the file already settles -- which account a row sits in, whether it appears in
 * `TRN_SPLIT` or `TRN_XFER`, whether it carries `hsec`, what its memo says. The
 * committed fixtures are far too small to see any of this: their rows carry only
 * 0x2, 0x10, 0x40 and 0x86.
 *
 * The bits, with the measurement that fixes each:
 *
 * | Mask | Meaning | Evidence |
 * |------|---------|----------|
 * | 0x2, 0x4 | Transfer side | 100% of both appear in `TRN_XFER` |
 * | 0x10 | Investment row | 100% carry `hsec` |
 * | 0x20 | Split parent | 100% appear in `TRN_SPLIT.htrnParent` |
 * | 0x40 | Split child | 100% appear in `TRN_SPLIT.htrn` |
 * | 0x80 | Row sits in a debt account | 1,239 rows, **all** in the 12 loan and mortgage accounts, and every row in those accounts has it |
 * | 0x100 | Voided | 31 rows, all `cs = 2`, half of them zero-amount, and their memos name a cancelled or never-presented cheque |
 * | 0x4000 | Loan-payment template | 50 rows, which is **exactly** the ten account-less `ps = 5` split parents plus their legs and those legs' transfer counterparts -- set equality in both directions, and one family per loan or mortgage account |
 * | 0x200000 | Member of a scheduled series | 4,653 of 4,692 are `frq != -1` templates, and no template lacks it |
 *
 * Only the two Monize acts on are exported; the rest are documented here and in
 * `docs/ms-money-data-model.md` so the next reader does not have to re-measure.
 */
export const MNY_TRANSACTION_FLAG = {
  /**
   * Transaction is voided. Monize imports it with status VOID.
   *
   * PR #192's format reference called this 0x80, and 0x80 is the bit every loan
   * and mortgage payment carries -- so **every loan payment imported as VOID**,
   * and because `computeExpectedBalances` skips voided rows, every loan and
   * mortgage balance sat frozen at its opening balance. 1,084 of the
   * maintainer's 33,734 transactions came in voided; the true count is 31.
   */
  VOID: 0x100,
  /**
   * The row belongs to a loan or mortgage account. Purely informational: which
   * account a row is in already says this, and nothing keys off the bit. It is
   * named so the 0x80-is-void mistake cannot be made again silently.
   */
  DEBT_ACCOUNT: 0x80,
  /**
   * The row is part of a loan-payment template -- Money's definition of the
   * next scheduled payment for a loan or mortgage, which the register never
   * shows.
   *
   * Money keeps one such family per debt account: a split parent with **no
   * `hacct` at all**, its principal/interest legs, and the legs' transfer
   * counterparts sitting in the loan account. `BILL.lHtrn` does not reference
   * them, so the bill-template filter never saw them.
   *
   * Only the parent was being skipped, and only because a row with no account
   * is unusable. The legs' counterparts kept their account and their date, so
   * they imported as ordinary principal postings that no payment ever funded:
   * twelve phantom rows adding $9,902.63 across seven of the maintainer's debt
   * accounts. The bit catches the whole family in one test.
   */
  LOAN_PAYMENT_TEMPLATE: 0x4000,
} as const;

export function isVoided(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.VOID) !== 0;
}

/**
 * True for a row in a loan or mortgage account. Never a reason to skip a row --
 * these are ordinary postings, and treating the bit as anything else is what
 * this function exists to make obvious.
 */
export function isDebtAccountRow(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.DEBT_ACCOUNT) !== 0;
}

/**
 * True for any row of a loan-payment template family -- parent, leg, or the
 * leg's counterpart in the loan account. Every one of them is scaffolding for
 * the *next* payment, so none is a posting.
 */
export function isLoanPaymentTemplate(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.LOAN_PAYMENT_TEMPLATE) !== 0;
}

/** `TRN.frq` on a real posting. Confirmed: every fixture row is -1. */
export const MNY_REAL_POSTING_FREQUENCY = -1;

/**
 * True when the row is a recurrence template rather than a posting. This is
 * the whole phantom-row rule for `frq`: auto-entered rows stay.
 */
export function isRecurrenceTemplate(frequency: number): boolean {
  return frequency !== MNY_REAL_POSTING_FREQUENCY;
}

/**
 * The Monize status for a transaction. Voided wins over the reconciliation
 * state; an unknown `cs` falls back to UNRECONCILED, which is the safe
 * direction (a wrongly-reconciled row hides a real discrepancy).
 */
export function mapTransactionStatus(
  clearedStatus: number,
  flags: number,
): TransactionStatus {
  if (isVoided(flags)) {
    return TransactionStatus.VOID;
  }
  return STATUS_BY_CODE.get(clearedStatus) ?? TransactionStatus.UNRECONCILED;
}

// ---------------------------------------------------------------------------
// Investment actions (`TRN.act`)
// ---------------------------------------------------------------------------

/**
 * Money investment action codes.
 *
 * These are read off `LOT`, which is Money's own record of which transaction
 * opened and closed each tax lot and therefore settles direction without
 * inference: whatever `act` a `LOT.htrnBuy` row carries acquires shares, and
 * whatever `LOT.htrnSell` carries disposes of them. Two independent Money Plus
 * files agree -- the maintainer's (4,616 lots) and the `sample.mny` shipped
 * with Money Plus (41 lots).
 *
 * The previous table came from PR #192's format reference and had **`act` 1 as
 * SELL**, which is backwards: `act` 1 opens 3,520 lots in the maintainer's file
 * and closes none. Every purchase imported as a sale, so no cash ever left a
 * brokerage sleeve, holdings replayed negative, and the investment half of the
 * ledger was pure credit.
 *
 * `act` 0, 5, 14, 15 and 16 appear in no Money Plus file and keep their
 * reference meanings; the fixtures are the only evidence for them (`act` 15
 * opens all 60 of money2002's lots, which is consistent with ADD_SHARES).
 * Where the two schemes disagree the lot evidence wins, because it is
 * measured rather than assumed.
 */
export const MNY_ACTION = {
  /** Money 2001-era buy. No Money Plus file uses it. */
  BUY_LEGACY: 0,
  /** Opens lots, `TRN.amt` positive: the money went out. */
  BUY: 1,
  /** Closes lots, `TRN.amt` negative: the money came in. */
  SELL: 2,
  /** Cash dividend. Has **no** `TRN_INV` row -- the amount is on `TRN.amt`. */
  DIVIDEND: 3,
  /** A second cash distribution, also without a `TRN_INV` row. */
  DISTRIBUTION: 4,
  /** Second reinvestment variant; the 3-versus-5 distinction is unconfirmed. */
  REINVEST_ALT: 5,
  /** Reinvested distribution: opens lots, and the cash never lands. */
  REINVEST: 9,
  /**
   * Opens lots for a stated value that **no cash pays for**: units credited to a
   * plan account from outside it. `act` 1 pairs with a cash row through
   * `TRN_XFER` 2,015 times in 2,029 (`act` 3, 1,090 of 1,090); `act` 12 does so
   * 0 times in 92, exactly like the `act` 9 reinvestments beside it, and 82 of
   * those 92 sit in one employer-matched RRSP (`ACCT.fEmpMatch`).
   *
   * Charging its value to the cash sleeve, as `BUY` does, is what left that
   * account $18,457.22 overdrawn where Money's own cash rows net to $91.00 --
   * the whole discrepancy, to the cent, was this code's 74 non-zero amounts.
   */
  CONTRIBUTION: 12,
  /** Closes lots with no cash. */
  REMOVE_SHARES: 13,
  /** Cash corporate action. Real-world meaning unconfirmed. */
  CAPITAL_GAIN: 14,
  /** Opens lots without a cash leg. Half of a cross-account transfer. */
  ADD_SHARES: 15,
  /** Closes lots without a cash leg. **Never** a sale. */
  REMOVE_SHARES_LEGACY: 16,
  /** Opens lots with no cash: the receiving half of a share transfer. */
  TRANSFER_IN: 32,
  /** Closes lots with no cash: the sending half of a share transfer. */
  TRANSFER_OUT: 33,
} as const;

const ACTION_BY_CODE: ReadonlyMap<number, InvestmentAction> = new Map([
  [MNY_ACTION.BUY_LEGACY, InvestmentAction.BUY],
  [MNY_ACTION.BUY, InvestmentAction.BUY],
  [MNY_ACTION.SELL, InvestmentAction.SELL],
  [MNY_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
  [MNY_ACTION.DISTRIBUTION, InvestmentAction.DIVIDEND],
  [MNY_ACTION.REINVEST_ALT, InvestmentAction.REINVEST],
  [MNY_ACTION.REINVEST, InvestmentAction.REINVEST],
  // Value and quantity like a buy, cash like a reinvestment -- and REINVEST is
  // the only Monize action that is both, so the cost basis survives.
  [MNY_ACTION.CONTRIBUTION, InvestmentAction.REINVEST],
  [MNY_ACTION.REMOVE_SHARES, InvestmentAction.REMOVE_SHARES],
  [MNY_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
  [MNY_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
  [MNY_ACTION.REMOVE_SHARES_LEGACY, InvestmentAction.REMOVE_SHARES],
  [MNY_ACTION.TRANSFER_IN, InvestmentAction.TRANSFER_IN],
  [MNY_ACTION.TRANSFER_OUT, InvestmentAction.TRANSFER_OUT],
]);

/**
 * Codes whose meaning is inferred rather than observed. A mapper must attach a
 * warning to every transaction it maps through one of these, so the
 * verification report shows the user what was assumed.
 *
 * `DISTRIBUTION` and `CONTRIBUTION` are here because the file proves what they
 * do -- to a position, and to cash -- but not what Money calls them: `act` 4 is
 * some cash distribution that is not the dividend `act` 3 already is, and `act`
 * 12 credits units to a plan account that nothing pays for. Both are mapped to
 * their measured effect and reported, which is the rule -- codes 10, 17, 18 and
 * 20 turn up in real files with no lot to explain them, so they stay unmapped
 * and are skipped with a warning rather than guessed at.
 */
export const MNY_UNCONFIRMED_ACTIONS: ReadonlySet<number> = new Set([
  MNY_ACTION.REINVEST_ALT,
  MNY_ACTION.CAPITAL_GAIN,
  MNY_ACTION.DISTRIBUTION,
  MNY_ACTION.CONTRIBUTION,
]);

/**
 * Codes that carry their amount on `TRN.amt` alone, with no `TRN_INV` row.
 * Iterating `TRN_INV` instead of `TRN` drops every one of them, which is
 * PR #192 issue 4.
 */
const CASH_ONLY_ACTIONS: ReadonlySet<number> = new Set([
  MNY_ACTION.DIVIDEND,
  MNY_ACTION.DISTRIBUTION,
]);

/**
 * The Monize action for a Money `act` code, or null when the code is unknown.
 * Unknown codes are skipped and counted, never guessed.
 *
 * Direction always comes from the action -- `TRN_INV.qty` is stored positive,
 * so inferring buy-versus-sell from a quantity sign silently corrupts
 * positions.
 */
export function mapInvestmentAction(act: number): InvestmentAction | null {
  return ACTION_BY_CODE.get(act) ?? null;
}

/**
 * False for the actions that carry no `TRN_INV` row -- the cash distributions.
 * Both Money Plus files confirm it: every `act` 3 and `act` 4 row is absent
 * from `TRN_INV`, and every other action has a row there.
 */
export function hasInvestmentDetail(act: number): boolean {
  return !CASH_ONLY_ACTIONS.has(act);
}

// ---------------------------------------------------------------------------
// Securities (`SEC.sct`)
// ---------------------------------------------------------------------------

/**
 * True when a symbol has the shape Money uses for a currency quote --
 * `/GBPUS`, `/ARSUS`. Confirmed: every `CRNC.szSymbol` in every fixture
 * matches, and no `SEC` row in any of them has the shape.
 */
export function isCurrencyQuoteSymbol(symbol: string): boolean {
  return /^\/[A-Z]{3}[A-Z]{2}$/.test(symbol);
}

/**
 * True when a `SEC` row is a currency rather than a real security.
 *
 * The symbol shape is the whole test, and deliberately so. This used to also
 * exclude `sct` 4 on the theory that Money files currencies in `SEC` under a
 * type code -- **`sct` 4 is a money-market fund**. Money Plus's own
 * `sample.mny` files "Vanguard Money Market Fund", "Merrill Lynch Money
 * Market", "Smith Barney Money Market" and "Woodgrove Money Market" under it,
 * and all four of the maintainer's are money-market funds too (TD Canadian
 * Money Market, CIBC Canadian Money Market, CIBC Canadian T-Bill, McLean
 * Budden Money Market). Excluding the code dropped 829 of that file's 4,524
 * investment transactions -- every money-market trade in seven brokerage
 * accounts -- as `missingInvestmentDetail`, because the security they point at
 * was never imported.
 *
 * Currencies do not live in `SEC` in any file measured: all five carry their
 * `/GBPUS`-shaped symbols in `CRNC` alone. `sct` codes are also not stable
 * across releases (the same Amex indices are `sct` 6 in Money 2001/2002 and
 * `sct` 7 in Money Plus), which is why none of them is read for meaning --
 * see the note on `mapSecurities` about `securityType` staying null.
 */
export function isCurrencyPseudoSecurity(symbol: string): boolean {
  return isCurrencyQuoteSymbol(symbol);
}

// ---------------------------------------------------------------------------
// Categories (`CAT.lType`)
// ---------------------------------------------------------------------------

/**
 * `CAT.lType` values. Confirmed across all three fixture vintages: -1 marks
 * the two roots, {0, 1} sit under EXPENSE and {2, 3} under INCOME, with no
 * crossover in 349 categories.
 */
export const MNY_CATEGORY_TYPE = {
  /** The INCOME and EXPENSE roots themselves. */
  ROOT: -1,
  EXPENSE: 0,
  EXPENSE_ALT: 1,
  INCOME: 2,
  INCOME_ALT: 3,
} as const;

const INCOME_TYPES: ReadonlySet<number> = new Set([
  MNY_CATEGORY_TYPE.INCOME,
  MNY_CATEGORY_TYPE.INCOME_ALT,
]);
const EXPENSE_TYPES: ReadonlySet<number> = new Set([
  MNY_CATEGORY_TYPE.EXPENSE,
  MNY_CATEGORY_TYPE.EXPENSE_ALT,
]);

/**
 * Whether a category is income, from `lType` alone; null for the roots and for
 * codes outside the confirmed set, where the caller falls back to walking to
 * the root ancestor (`INCOME` `hcat` 130 versus `EXPENSE` 131 in every
 * fixture, though the handles are not guaranteed).
 */
export function isIncomeCategoryType(categoryType: number): boolean | null {
  if (INCOME_TYPES.has(categoryType)) {
    return true;
  }
  return EXPENSE_TYPES.has(categoryType) ? false : null;
}

// ---------------------------------------------------------------------------
// Frequencies (`BILL.frq` + `BILL.cFrqInst`)
// ---------------------------------------------------------------------------

/**
 * Money recurrence codes. **Unconfirmed** -- `BILL` is empty in every fixture.
 * From PR #192's format reference.
 */
export const MNY_FREQUENCY = {
  ONCE: 0,
  DAILY: 1,
  WEEKLY: 2,
  MONTHLY: 3,
  YEARLY: 4,
  EVERY_2_MONTHS: 5,
  QUARTERLY: 6,
  SEMIANNUAL: 7,
} as const;

export interface MnyFrequencyMapping {
  readonly frequency: FrequencyType;
  /**
   * True when Monize has no exact equivalent, so the mapping changes how often
   * the bill falls due, and the mapper must warn per bill. Every Money
   * recurrence *code* now maps exactly (Track B task B3 added `EVERY2MONTHS`
   * and `SEMIANNUAL`); only an unrepresentable `cFrqInst` interval -- weekly
   * every 3 weeks, monthly every 5 months -- still approximates.
   */
  readonly approximate: boolean;
}

const EXACT: Record<number, FrequencyType> = {
  [MNY_FREQUENCY.ONCE]: FrequencyType.ONCE,
  [MNY_FREQUENCY.DAILY]: FrequencyType.DAILY,
  [MNY_FREQUENCY.WEEKLY]: FrequencyType.WEEKLY,
  [MNY_FREQUENCY.MONTHLY]: FrequencyType.MONTHLY,
  [MNY_FREQUENCY.YEARLY]: FrequencyType.YEARLY,
  [MNY_FREQUENCY.EVERY_2_MONTHS]: FrequencyType.EVERY2MONTHS,
  [MNY_FREQUENCY.QUARTERLY]: FrequencyType.QUARTERLY,
  [MNY_FREQUENCY.SEMIANNUAL]: FrequencyType.SEMIANNUAL,
};

/** Weekly recurrences whose interval Monize expresses as its own type. */
const WEEKLY_BY_INTERVAL: Record<number, FrequencyType> = {
  2: FrequencyType.BIWEEKLY,
  4: FrequencyType.EVERY4WEEKS,
};

/** Monthly recurrences whose interval Monize expresses as its own type. */
const MONTHLY_BY_INTERVAL: Record<number, FrequencyType> = {
  2: FrequencyType.EVERY2MONTHS,
  3: FrequencyType.QUARTERLY,
  6: FrequencyType.SEMIANNUAL,
  12: FrequencyType.YEARLY,
};

/**
 * Maps a Money recurrence onto a Monize frequency.
 *
 * `cFrqInst` is Money's interval multiplier: weekly with an interval of 2 is
 * exactly Monize's BIWEEKLY, monthly with 3 is QUARTERLY. Every Money
 * recurrence code has an exact Monize type since task B3 added `EVERY2MONTHS`
 * and `SEMIANNUAL`, so only an interval with no matching type (weekly every 3
 * weeks, monthly every 5 months) still falls to the next **shorter** period and
 * is flagged approximate. Shorter is the safer error: v1 imports bills with
 * `auto_post = false`, so an extra reminder is noise while a missed one is a
 * missed payment. (PR #192 erred in both directions, turning bimonthly bills
 * into biweekly ones and semiannual bills into yearly ones.)
 *
 * Returns null for an unknown code, which the mapper reports rather than
 * guesses.
 */
export function mapFrequency(
  frequency: number,
  interval = 1,
): MnyFrequencyMapping | null {
  const steps =
    Number.isFinite(interval) && interval >= 1 ? Math.round(interval) : 1;

  if (frequency === MNY_FREQUENCY.WEEKLY && steps > 1) {
    const exact = WEEKLY_BY_INTERVAL[steps];
    return exact
      ? { frequency: exact, approximate: false }
      : { frequency: FrequencyType.WEEKLY, approximate: true };
  }

  if (frequency === MNY_FREQUENCY.MONTHLY && steps > 1) {
    const exact = MONTHLY_BY_INTERVAL[steps];
    return exact
      ? { frequency: exact, approximate: false }
      : { frequency: FrequencyType.MONTHLY, approximate: true };
  }

  const exact = EXACT[frequency];
  return exact ? { frequency: exact, approximate: false } : null;
}

// ---------------------------------------------------------------------------
// Bills (`BILL.st`)
// ---------------------------------------------------------------------------

/*
 * No `BILL.st` constants are exported, on purpose.
 *
 * Which rows belong to a live series is still open (design question 3):
 * `BILL` is empty in every committed fixture, so no value of `st` has ever
 * been observed. The table carries both `hbillHead` (series) and `iinst`
 * (instance), which suggests rows are instances of a series rather than series
 * themselves, but that is inference, not evidence. Task M3.1 must derive the
 * active set from a real file and validate it against the known "about 20 real
 * bills out of 1,844 rows" ground truth; the wizard's checkbox list is the
 * safety net either way. A plausible-looking constant here would only make the
 * guess harder to see.
 */
