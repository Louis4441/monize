import apiClient from './api';
import { AccountType } from '@/types/account';

/**
 * Client for the Microsoft Money (`.mny`) import endpoints.
 *
 * Two things differ from the QIF/OFX/CSV client. The file goes up as multipart
 * binary rather than as text in a JSON body -- a `.mny` file is a Jet database
 * and reading it with `File.text()` would corrupt it. And the import is a
 * background job, so `start` returns a job to poll rather than a result.
 *
 * Timeouts are per call because the defaults cannot fit both: decrypting and
 * parsing a 200 MB file takes far longer than the shared 10 s, while a poll that
 * hangs for 10 s makes the progress bar feel broken.
 */

/** Upload + parse of a 200 MB-class file, including the round trip. */
const PARSE_TIMEOUT_MS = 300_000;
/** A poll is a single indexed row read; anything slower is a real problem. */
const POLL_TIMEOUT_MS = 10_000;

export type MnyEra = 'money2001' | 'money2002' | 'moneyPlus' | 'unknown';

export type MnyImportPhase =
  | 'preparing'
  | 'reference'
  | 'transactions'
  | 'investments'
  | 'bills'
  | 'prices'
  | 'finalizing'
  | 'verifying';

export type MnyJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface MnyPreviewAccount {
  key: string;
  handle: number | null;
  name: string;
  moneyName: string;
  accountType: AccountType;
  accountSubType: 'INVESTMENT_CASH' | 'INVESTMENT_BROKERAGE' | null;
  currencyCode: string;
  transactionCount: number;
  openingBalance: number;
  finalBalance: number;
  closed: boolean;
  favourite: boolean;
}

export interface MnyPreviewCounts {
  accountsIncluded: number;
  accountsInFile: number;
  payeesToCreate: number;
  payeesInFile: number;
  categoriesToCreate: number;
  categoriesInFile: number;
  transactionsToCreate: number;
  transfersToLink: number;
  transactionsSkipped: number;
  investmentsDeferred: number;
}

export interface MnyFileCounts {
  accounts: number;
  payees: number;
  categories: number;
  securities: number;
  securityPrices: number;
  exchangeRates: number;
  bills: number;
  transactions: number;
}

export interface MnyWarningSummary {
  code: string;
  count: number;
  samples: string[];
}

export interface MnyImportOptions {
  wipeExistingData: boolean;
  referencedOnlyPayees: boolean;
  referencedOnlyCategories: boolean;
  importClosedAccounts: boolean;
  importPrices: boolean;
  importExchangeRates: boolean;
  accounts: Array<{
    handle: number;
    include: boolean;
    currencyOverride: string | null;
  }>;
  bills: number[];
}

export interface MnyPreview {
  stagedFileId: string;
  filename: string;
  sizeBytes: number;
  era: MnyEra;
  passwordProtected: boolean;
  baseCurrency: string;
  accounts: MnyPreviewAccount[];
  counts: MnyPreviewCounts;
  fileCounts: MnyFileCounts;
  missingTables: string[];
  missingFields: string[];
  warnings: MnyWarningSummary[];
  options: MnyImportOptions;
}

export interface MnyAccountVerification {
  accountName: string;
  accountId: string | null;
  expectedBalance: number;
  importedBalance: number;
  delta: number;
  transactionCount: number;
  matches: boolean;
}

export interface MnyImportResult {
  accountsCreated: number;
  payeesCreated: number;
  categoriesCreated: number;
  transactionsCreated: number;
  splitsCreated: number;
  transfersLinked: number;
  securitiesCreated: number;
  investmentTransactionsCreated: number;
  pricesImported: number;
  exchangeRatesImported: number;
  billsCreated: number;
  skipped: {
    accounts: number;
    payees: number;
    categories: number;
    transactions: number;
  };
  existingDataRemoved: boolean;
  verification: MnyAccountVerification[];
  warnings: MnyWarningSummary[];
}

export interface MnyImportJob {
  id: string;
  status: MnyJobStatus;
  progress: {
    phase: MnyImportPhase;
    processed: number;
    total: number;
  } | null;
  result: MnyImportResult | null;
  errorKey: string | null;
  retryable: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

/** Options the wizard sends; every field is optional and server-defaulted. */
export type MnyImportOptionsInput = Partial<
  Omit<MnyImportOptions, 'accounts' | 'bills'>
> & {
  accounts?: MnyImportOptions['accounts'];
  bills?: number[];
};

export const mnyImportApi = {
  /**
   * Uploads the file, decrypts and previews it, and stages it for import.
   * The password is sent only on this call and is never stored server-side.
   */
  parse: async (file: File, password?: string): Promise<MnyPreview> => {
    const formData = new FormData();
    formData.append('file', file);
    if (password) {
      formData.append('password', password);
    }
    const response = await apiClient.post<MnyPreview>(
      '/import/mny/parse',
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: PARSE_TIMEOUT_MS,
      },
    );
    return response.data;
  },

  start: async (
    stagedFileId: string,
    options?: MnyImportOptionsInput,
    wipeCredentials?: { password?: string; oidcIdToken?: string },
  ): Promise<MnyImportJob> => {
    const response = await apiClient.post<MnyImportJob>('/import/mny/start', {
      stagedFileId,
      ...(options ? { options } : {}),
      ...(wipeCredentials?.password
        ? { wipePassword: wipeCredentials.password }
        : {}),
      ...(wipeCredentials?.oidcIdToken
        ? { wipeOidcIdToken: wipeCredentials.oidcIdToken }
        : {}),
    });
    return response.data;
  },

  getJob: async (id: string): Promise<MnyImportJob> => {
    const response = await apiClient.get<MnyImportJob>(
      `/import/mny/jobs/${id}`,
      { timeout: POLL_TIMEOUT_MS },
    );
    return response.data;
  },

  discardStagedFile: async (id: string): Promise<void> => {
    await apiClient.delete(`/import/mny/staged/${id}`);
  },
};
