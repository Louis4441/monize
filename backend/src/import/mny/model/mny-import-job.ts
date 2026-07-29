import { MnyWarningSummary } from "./mny-warnings";

/**
 * The shape of a background import job as the wizard sees it.
 *
 * A `.mny` file with 37,000 transactions cannot finish inside a request, so the
 * import is a job row the wizard polls (design ADR-3). Everything here travels
 * as JSON in `import_jobs.progress` / `.result`, so it is deliberately flat and
 * free of English copy: phases and warning codes are localized by the frontend.
 */

export const IMPORT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** Ordered so the wizard can render a progress rail, not just a label. */
export const MNY_IMPORT_PHASES = [
  "preparing",
  "reference",
  "transactions",
  "investments",
  "bills",
  "prices",
  "finalizing",
  "verifying",
] as const;

export type MnyImportPhase = (typeof MNY_IMPORT_PHASES)[number];

export interface MnyImportProgress {
  readonly phase: MnyImportPhase;
  /** Rows finished in this phase; 0 when the phase has no meaningful count. */
  readonly processed: number;
  /** Rows this phase will process, or 0 when not countable up front. */
  readonly total: number;
}

/** One account's line in the verification report. */
export interface MnyAccountVerification {
  readonly accountName: string;
  /** Null when the account was skipped or failed to create. */
  readonly accountId: string | null;
  /** Final balance computed from the Money file by the parser. */
  readonly expectedBalance: number;
  /** Balance Monize holds after the import. */
  readonly importedBalance: number;
  /** `importedBalance - expectedBalance`, rounded to four places. */
  readonly delta: number;
  readonly transactionCount: number;
  /** True when `delta` is within the reconciliation tolerance. */
  readonly matches: boolean;
}

/** What the import created, and whether the result reconciles. */
export interface MnyImportResult {
  readonly accountsCreated: number;
  readonly payeesCreated: number;
  readonly categoriesCreated: number;
  readonly transactionsCreated: number;
  readonly splitsCreated: number;
  readonly transfersLinked: number;
  readonly securitiesCreated: number;
  readonly investmentTransactionsCreated: number;
  readonly pricesImported: number;
  readonly exchangeRatesImported: number;
  readonly billsCreated: number;
  /** Rows the mapper could not use, by reason. Mirrors the warning codes. */
  readonly skipped: {
    readonly accounts: number;
    readonly payees: number;
    readonly categories: number;
    readonly transactions: number;
  };
  /** True when the wizard's wipe option ran the delete-my-data pre-step. */
  readonly existingDataRemoved: boolean;
  readonly verification: readonly MnyAccountVerification[];
  readonly warnings: readonly MnyWarningSummary[];
}

/**
 * A balance is considered reconciled within half a cent. Money and Monize both
 * store four decimal places, but a file whose amounts were entered in a
 * different currency's minor unit can differ in the fourth place without
 * anything being wrong.
 */
export const BALANCE_TOLERANCE = 0.005;

export function balanceMatches(delta: number): boolean {
  return Math.abs(delta) <= BALANCE_TOLERANCE;
}
