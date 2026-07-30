import {
  AccountSubType,
  AccountType,
} from "../../../accounts/entities/account.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { MnyWarning } from "./mny-warnings";

/**
 * The intermediate representation the mappers produce and the writer consumes
 * (design ADR-8).
 *
 * Deliberately its own model rather than the QIF parser's: the QIF shape cannot
 * carry exact transfer links, per-account currencies, closed/favourite flags, or
 * investment transfer semantics -- and the QIF processor's name-and-amount
 * transfer *matching* is exactly what a file with authoritative `TRN_XFER` pairs
 * must never fall back to.
 *
 * Nothing here touches the database. Identities are import-local keys and
 * pre-generated UUIDs, so transfer pairs and splits are fully wired before the
 * first INSERT.
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface MappedAccount {
  /**
   * Identity within this import. A Money account maps to `acct-<hacct>`; the
   * cash side Monize requires for an investment account that has no Money
   * companion is `acct-<hacct>-cash`.
   */
  readonly key: string;
  /**
   * The Money `hacct` whose transactions land in this account, or null for a
   * synthesized investment cash side.
   */
  readonly handle: number | null;
  /** Name Monize will use, after de-duplication and pair suffixing. */
  readonly name: string;
  /** Name as Money recorded it, for the review table and warnings. */
  readonly moneyName: string;
  readonly accountType: AccountType;
  readonly accountSubType: AccountSubType | null;
  readonly currencyCode: string;
  readonly openingBalance: number;
  readonly creditLimit: number | null;
  /**
   * Applied **after** the account's transactions are written:
   * `AccountsService.updateBalance` rejects closed accounts.
   */
  readonly closed: boolean;
  readonly closedDate: string | null;
  readonly favourite: boolean;
  readonly description: string | null;
  /** The other half of an investment pair, by `key`. */
  readonly linkedKey: string | null;
}

export interface MappedAccounts {
  /** The file's own base currency, or the user's preference when it has none. */
  readonly baseCurrency: string;
  /** ISO codes the import must ensure exist, base currency included. */
  readonly currencyCodes: readonly string[];
  readonly accounts: readonly MappedAccount[];
  /** Money `hacct` -> account key. An excluded account is absent. */
  readonly keyByHandle: ReadonlyMap<number, string>;
  /** Money `hacct` -> currency of the Monize account it maps to. */
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** Accounts left out by an unknown type or by the wizard's selection. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Categories and payees
// ---------------------------------------------------------------------------

export interface MappedCategory {
  /** `CAT.hcat`. */
  readonly handle: number;
  /** Monize parent name, or null for a top-level category. */
  readonly parentName: string | null;
  /**
   * Monize category name. A Money tree deeper than two levels is flattened
   * into a colon-joined child name (`Utilities:Gas:Winter` -> parent
   * `Utilities`, name `Gas:Winter`).
   */
  readonly name: string;
  /** `parentName:name`, the writer's find-or-create identity. */
  readonly fullName: string;
  readonly isIncome: boolean;
}

export interface MappedCategories {
  /** Unique by `fullName`, ordered parents-before-children. */
  readonly categories: readonly MappedCategory[];
  /** Every `hcat` that maps somewhere, including duplicates by name. */
  readonly byHandle: ReadonlyMap<number, MappedCategory>;
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

export interface MappedPayee {
  readonly handle: number;
  readonly name: string;
}

export interface MappedPayees {
  /** Unique by name, since `payees` is unique on `(user_id, name)`. */
  readonly payees: readonly MappedPayee[];
  readonly nameByHandle: ReadonlyMap<number, string>;
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface MappedSplit {
  readonly kind: SplitKind;
  /** Money `hcat` for a category split; null for a transfer split. */
  readonly categoryHandle: number | null;
  /** Account key for a transfer split -- the loan or destination account. */
  readonly transferAccountKey: string | null;
  /**
   * The counterpart transaction of a transfer split. Pre-generated, so the
   * split is wired before either row is inserted.
   */
  readonly linkedTransactionId: string | null;
  readonly amount: number;
  readonly memo: string | null;
}

export interface MappedTransaction {
  /** Pre-generated UUID: transfer pairs and splits reference it before insert. */
  readonly id: string;
  /** `TRN.htrn`, for warnings and for pairing. */
  readonly handle: number;
  readonly accountKey: string;
  readonly transactionDate: string;
  readonly amount: number;
  readonly currencyCode: string;
  readonly status: TransactionStatus;
  readonly payeeHandle: number | null;
  readonly categoryHandle: number | null;
  readonly description: string | null;
  readonly referenceNumber: string | null;
  readonly isTransfer: boolean;
  /** The other side of a `TRN_XFER` pair. Exact -- never name-matched. */
  readonly linkedTransactionId: string | null;
  readonly splits: readonly MappedSplit[];
}

export interface MappedTransactions {
  readonly transactions: readonly MappedTransaction[];
  /** Payee handles an imported transaction actually uses. */
  readonly referencedPayees: ReadonlySet<number>;
  /** Category handles an imported transaction or split actually uses. */
  readonly referencedCategories: ReadonlySet<number>;
  /** Transfer pairs fully linked in both directions. */
  readonly transfersLinked: number;
  /** `TRN` rows that are real postings but could not be imported. */
  readonly skipped: number;
  /**
   * Rows carrying a security, left for the investment mapper. Not a warning:
   * Phase 1 imports banking data and Phase 2 picks these up from the same
   * tables.
   */
  readonly deferredInvestments: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Securities and investments
// ---------------------------------------------------------------------------

export interface MappedSecurity {
  /** `SEC.hsec`. */
  readonly handle: number;
  /**
   * Symbol Monize will use: trimmed, unique within the import and within the
   * `securities` column width. Never shared with another security -- PR #192
   * upserted on `(user_id, symbol)` and collapsed distinct funds into one.
   */
  readonly symbol: string;
  /** Symbol as Money recorded it; empty when Money had none. */
  readonly moneySymbol: string;
  readonly name: string;
  readonly currencyCode: string;
  /**
   * True for a generated placeholder symbol, which no quote provider can
   * resolve. Matches the QIF importer's convention for auto-created securities.
   */
  readonly skipPriceUpdates: boolean;
}

export interface MappedSecurities {
  readonly securities: readonly MappedSecurity[];
  readonly byHandle: ReadonlyMap<number, MappedSecurity>;
  /** Currency pseudo-securities and rows with no usable identity. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

export interface MappedInvestmentTransaction {
  /** Pre-generated UUID, so a share-transfer pair is wired before insert. */
  readonly id: string;
  /** `TRN.htrn`, or null for a `SEC_SPLIT`-derived SPLIT row. */
  readonly handle: number | null;
  /** The brokerage account key the shares move in. */
  readonly accountKey: string;
  /** The cash sleeve the cash leg lands in; null when the action moves no cash. */
  readonly cashAccountKey: string | null;
  readonly securityHandle: number;
  readonly action: InvestmentAction;
  readonly transactionDate: string;
  /**
   * Always positive -- direction comes from `action`, never from a sign
   * (`TRN_INV.qty` is stored positive). For a SPLIT this is the ratio the
   * holdings fold multiplies by.
   */
  readonly quantity: number | null;
  readonly price: number | null;
  readonly commission: number;
  /** Positive magnitude of the transaction, in the account's currency. */
  readonly totalAmount: number;
  readonly currencyCode: string;
  /** Signed cash impact on the cash sleeve; 0 for the share-only actions. */
  readonly cashAmount: number;
  readonly status: TransactionStatus;
  readonly payeeHandle: number | null;
  readonly categoryHandle: number | null;
  readonly description: string | null;
  /** The other leg of an `act` 15/16 share transfer. */
  readonly linkedInvestmentId: string | null;
}

export interface MappedInvestments {
  readonly transactions: readonly MappedInvestmentTransaction[];
  /** Security handles an imported investment row actually uses. */
  readonly referencedSecurities: ReadonlySet<number>;
  readonly referencedPayees: ReadonlySet<number>;
  readonly referencedCategories: ReadonlySet<number>;
  /** `act` 15/16 pairs turned into linked TRANSFER_IN / TRANSFER_OUT rows. */
  readonly transfersPaired: number;
  /** SPLIT rows synthesized from `SEC_SPLIT`. */
  readonly splitsApplied: number;
  /** Security-carrying rows that could not be imported. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

/** One holding's line in the LOT cross-check (design task M2.3). */
export interface MnyHoldingCheck {
  readonly accountKey: string;
  readonly securityHandle: number;
  readonly symbol: string;
  /** Shares open lots say the account holds (`LOT` rows with no `htrnSell`). */
  readonly lotQuantity: number;
  /** Shares replaying the mapped investment actions produces. */
  readonly replayQuantity: number;
  /** `replayQuantity - lotQuantity`. */
  readonly delta: number;
  readonly matches: boolean;
}
