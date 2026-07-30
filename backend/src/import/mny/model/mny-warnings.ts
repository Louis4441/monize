/**
 * Warnings produced while mapping a Money file.
 *
 * A warning is never a failure: the import always completes and tells the user
 * what it assumed or skipped. Codes are stable identifiers that the frontend
 * turns into localized copy (`import.mnyWarnings.<code>`), so a warning never
 * carries an English sentence -- only the code plus the untranslated specifics
 * (an account name, a Money action code, a balance delta) that no catalog can
 * supply.
 */

export const MNY_WARNING_CODES = [
  /** This Money version has no such table; the feature it drives is skipped. */
  "missingTable",
  /** A column the reader wanted is absent, so the field took its default. */
  "missingField",
  /** `ACCT.at` held a code outside the known set; the account is skipped. */
  "unknownAccountType",
  /** Two Money accounts share a name after trimming; the second is suffixed. */
  "duplicateAccountName",
  /** An account or security referenced a currency handle the file lacks. */
  "unknownCurrency",
  /** Money's category tree ran deeper than Monize's two levels. */
  "categoryFlattened",
  /** `CAT.lType` was outside the confirmed set; income/expense came from the tree. */
  "categoryTypeInferred",
  /** A payee named `#`, `*` or blank: Money's degenerate rows, never imported. */
  "degeneratePayeeSkipped",
  /** A `TRN` row with no account, or a date outside the representable range. */
  "unusableTransaction",
  /** A `TRN_XFER` side whose counterpart is missing or excluded from the import. */
  "orphanedTransferSide",
  /** A `TRN_SPLIT` child whose parent is not being imported. */
  "orphanedSplit",
  /** A split's legs do not add up to the parent transaction's amount. */
  "splitSumMismatch",
  /**
   * A transfer whose counterpart sits in an account the user left out, so the
   * row imports as an ordinary transaction rather than half a transfer.
   */
  "transferAcrossExcludedAccount",
  /** The account's file-computed final balance and its imported balance differ. */
  "balanceMismatch",
  /**
   * Two `SEC` rows resolve to the same symbol, so the second is suffixed
   * (`VOO-2`). PR #192 upserted on the symbol instead and silently collapsed
   * distinct funds into one security.
   */
  "duplicateSecuritySymbol",
  /** A `SEC` row has no symbol; a placeholder was generated and price updates disabled. */
  "generatedSecuritySymbol",
  /** `TRN.act` held a code outside the known set; the investment row is skipped. */
  "unknownInvestmentAction",
  /** The row was mapped through an action whose meaning is inferred, not observed. */
  "unconfirmedInvestmentAction",
  /** A security-carrying `TRN` row with no `TRN_INV` detail and no way to infer one. */
  "missingInvestmentDetail",
  /** An investment row in an account that is not an investment account. */
  "investmentAccountMismatch",
  /** An `act` 15/16 row with no counterpart, so it stays ADD/REMOVE_SHARES. */
  "unpairedShareTransfer",
  /** A `SEC_SPLIT` row no price row resolves to a security, or with an unusable ratio. */
  "unusableSecuritySplit",
  /** LOT-derived open shares and the action replay disagree for a holding. */
  "holdingsMismatch",
] as const;

export type MnyWarningCode = (typeof MNY_WARNING_CODES)[number];

export interface MnyWarning {
  readonly code: MnyWarningCode;
  /**
   * The Money entity the warning is about -- an account or payee name, a table
   * name, a transaction handle. Untranslated by design.
   */
  readonly subject?: string;
  /** Extra specifics: a raw code, a delta, the column that was missing. */
  readonly detail?: string;
}

/** One code's worth of warnings, for the review step's grouped display. */
export interface MnyWarningSummary {
  readonly code: MnyWarningCode;
  readonly count: number;
  /** Up to `MAX_WARNING_SAMPLES` subjects, so a 4,000-row warning stays small. */
  readonly samples: readonly string[];
}

export const MAX_WARNING_SAMPLES = 5;

/**
 * Groups warnings by code, keeping a bounded sample of subjects. The preview
 * and the verification report both travel as JSON through a polling endpoint,
 * so an unbounded warning list is a payload problem, not just a UI one.
 */
export function summarizeWarnings(
  warnings: readonly MnyWarning[],
): MnyWarningSummary[] {
  return MNY_WARNING_CODES.filter((code) =>
    warnings.some((warning) => warning.code === code),
  ).map((code) => {
    const matching = warnings.filter((warning) => warning.code === code);
    return {
      code,
      count: matching.length,
      samples: matching
        .map((warning) => warning.subject)
        .filter((subject): subject is string => subject !== undefined)
        .slice(0, MAX_WARNING_SAMPLES),
    };
  });
}
