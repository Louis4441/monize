import {
  AccountSubType,
  AccountType,
} from "../../accounts/entities/account.entity";
import { MnyImportOptions } from "./model/mny-import-options";
import { MnyWarningSummary, summarizeWarnings } from "./model/mny-warnings";
import { MnyEra, MnyFileCounts, MnyParsedFile } from "./mny-parser.service";

/**
 * What the wizard's review step gets: summaries only, never row data.
 *
 * A 200 MB file with 37,000 transactions must produce a preview measured in
 * kilobytes, because it travels through the Next proxy and is re-fetched on every
 * step change. Everything here is JSON-safe and free of English copy -- eras,
 * warning codes and account types are localized by the frontend.
 */

export interface MnyPreviewAccount {
  /** Import-local key; the wizard sends per-account options keyed by `handle`. */
  readonly key: string;
  /** `ACCT.hacct`, or null for the cash side Monize adds to an investment pair. */
  readonly handle: number | null;
  readonly name: string;
  /** Name as Money recorded it, so a renamed account is visible as such. */
  readonly moneyName: string;
  readonly accountType: AccountType;
  readonly accountSubType: AccountSubType | null;
  readonly currencyCode: string;
  readonly transactionCount: number;
  readonly openingBalance: number;
  /** Final balance computed from the file -- the verification baseline. */
  readonly finalBalance: number;
  readonly closed: boolean;
  readonly favourite: boolean;
}

export interface MnyPreviewCounts {
  readonly accountsIncluded: number;
  readonly accountsInFile: number;
  readonly payeesToCreate: number;
  readonly payeesInFile: number;
  readonly categoriesToCreate: number;
  readonly categoriesInFile: number;
  readonly transactionsToCreate: number;
  readonly transfersToLink: number;
  readonly transactionsSkipped: number;
  /** Investment rows Phase 1 leaves alone; Phase 2 imports them. */
  readonly investmentsDeferred: number;
}

export interface MnyPreview {
  /** Staged file the import will read. Empty until the controller fills it in. */
  readonly stagedFileId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly era: MnyEra;
  readonly passwordProtected: boolean;
  readonly baseCurrency: string;
  readonly accounts: readonly MnyPreviewAccount[];
  readonly counts: MnyPreviewCounts;
  /** Raw file counts, including the things Phase 1 does not import yet. */
  readonly fileCounts: MnyFileCounts;
  /** Tables this Money version does not have, e.g. `BILL` on a 2001 file. */
  readonly missingTables: readonly string[];
  /** Fields that fell back to a default because no source column existed. */
  readonly missingFields: readonly string[];
  readonly warnings: readonly MnyWarningSummary[];
  /** The option set the import will use, with server-computed defaults filled. */
  readonly options: MnyImportOptions;
}

export interface BuildPreviewInput {
  readonly parsed: MnyParsedFile;
  readonly stagedFileId: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

export function buildPreview(input: BuildPreviewInput): MnyPreview {
  const { parsed } = input;

  const accounts: MnyPreviewAccount[] = parsed.accounts.accounts.map(
    (account) => ({
      key: account.key,
      handle: account.handle,
      name: account.name,
      moneyName: account.moneyName,
      accountType: account.accountType,
      accountSubType: account.accountSubType,
      currencyCode: account.currencyCode,
      transactionCount: parsed.transactionCounts.get(account.key) ?? 0,
      openingBalance: account.openingBalance,
      finalBalance: parsed.expectedBalances.get(account.key) ?? 0,
      closed: account.closed,
      favourite: account.favourite,
    }),
  );

  return {
    stagedFileId: input.stagedFileId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    era: parsed.era,
    passwordProtected: parsed.passwordProtected,
    baseCurrency: parsed.baseCurrency,
    accounts,
    counts: {
      accountsIncluded: accounts.length,
      accountsInFile: parsed.fileCounts.accounts,
      payeesToCreate: parsed.payees.payees.length,
      payeesInFile: parsed.fileCounts.payees,
      categoriesToCreate: parsed.categories.categories.length,
      categoriesInFile: parsed.fileCounts.categories,
      transactionsToCreate: parsed.transactions.transactions.length,
      transfersToLink: parsed.transactions.transfersLinked,
      transactionsSkipped: parsed.transactions.skipped,
      investmentsDeferred: parsed.transactions.deferredInvestments,
    },
    fileCounts: parsed.fileCounts,
    missingTables: parsed.missingTables,
    missingFields: parsed.missingFields,
    warnings: summarizeWarnings(parsed.warnings),
    options: parsed.options,
  };
}
