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
 * Bits of the `TRN.grftt` flag word. **Unconfirmed** -- the fixture rows carry
 * only 0x2 (Money 2001/2002) and 0x10 (Money Plus), neither of which is one of
 * these. Both bits come from PR #192.
 */
export const MNY_TRANSACTION_FLAG = {
  /** Transaction is voided. Monize imports it with status VOID. */
  VOID: 0x80,
  /**
   * Posted by Money's scheduler rather than typed by hand. These are **real
   * postings** -- excluding them is what made loan accounts import empty in
   * PR #192.
   */
  AUTO_ENTERED: 0x8000,
} as const;

export function isVoided(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.VOID) !== 0;
}

export function isAutoEntered(flags: number): boolean {
  return (flags & MNY_TRANSACTION_FLAG.AUTO_ENTERED) !== 0;
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
 * Money investment action codes. Confirmed in the fixtures: 0, 1 and 15. The
 * rest come from PR #192's format reference, corrected by this design -- most
 * importantly 16, which the proof of concept mapped to SELL and which actually
 * removes shares.
 */
export const MNY_ACTION = {
  BUY: 0,
  SELL: 1,
  /** Reinvested distribution. */
  REINVEST: 3,
  /** Cash dividend. Has **no** `TRN_INV` row -- the amount is on `TRN.amt`. */
  DIVIDEND: 4,
  /** Second reinvestment variant; the 3-versus-5 distinction is unconfirmed. */
  REINVEST_ALT: 5,
  /** Cash corporate action. Real-world meaning unconfirmed. */
  CAPITAL_GAIN: 14,
  /** Opens lots without a cash leg. Half of a cross-account transfer. */
  ADD_SHARES: 15,
  /** Closes lots without a cash leg. **Never** a sale. */
  REMOVE_SHARES: 16,
} as const;

const ACTION_BY_CODE: ReadonlyMap<number, InvestmentAction> = new Map([
  [MNY_ACTION.BUY, InvestmentAction.BUY],
  [MNY_ACTION.SELL, InvestmentAction.SELL],
  [MNY_ACTION.REINVEST, InvestmentAction.REINVEST],
  [MNY_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
  [MNY_ACTION.REINVEST_ALT, InvestmentAction.REINVEST],
  [MNY_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
  [MNY_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
  [MNY_ACTION.REMOVE_SHARES, InvestmentAction.REMOVE_SHARES],
]);

/**
 * Codes whose meaning is inferred rather than observed. A mapper must attach a
 * warning to every transaction it maps through one of these, so the
 * verification report shows the user what was assumed.
 */
export const MNY_UNCONFIRMED_ACTIONS: ReadonlySet<number> = new Set([
  MNY_ACTION.REINVEST_ALT,
  MNY_ACTION.CAPITAL_GAIN,
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
 * False for the one action that carries no `TRN_INV` row. Iterating `TRN_INV`
 * instead of `TRN` drops every cash dividend, which is PR #192 issue 4.
 */
export function hasInvestmentDetail(act: number): boolean {
  return act !== MNY_ACTION.DIVIDEND;
}

// ---------------------------------------------------------------------------
// Securities (`SEC.sct`)
// ---------------------------------------------------------------------------

/**
 * Money stores currencies as pseudo-securities of this type; they must not
 * become Monize securities. **Unconfirmed** -- no fixture contains one, and
 * `sct` codes are demonstrably not stable across releases: the same Amex index
 * securities are `sct` 6 in Money 2001/2002 and the Money Plus indices are
 * `sct` 7. Pair the code test with `isCurrencyQuoteSymbol`.
 */
export const MNY_SECURITY_TYPE_CURRENCY = 4;

/**
 * True when a symbol has the shape Money uses for a currency quote --
 * `/GBPUS`, `/ARSUS`. Confirmed: every `CRNC.szSymbol` in every fixture
 * matches. Unlike `sct`, this does not shift between releases, so it is the
 * version-independent half of the currency-pseudo-security test.
 */
export function isCurrencyQuoteSymbol(symbol: string): boolean {
  return /^\/[A-Z]{3}[A-Z]{2}$/.test(symbol);
}

/**
 * True when a `SEC` row is a currency rather than a real security, by either
 * signal.
 */
export function isCurrencyPseudoSecurity(
  securityType: number,
  symbol: string,
): boolean {
  return (
    securityType === MNY_SECURITY_TYPE_CURRENCY || isCurrencyQuoteSymbol(symbol)
  );
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
