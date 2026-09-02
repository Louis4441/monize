import { Category } from './category';

/** Where a looked-up contact detail came from. Mirrors the backend's list. */
export type ContactLookupSource =
  | 'ai-web-search'
  | 'ai-knowledge'
  | 'ai-relay'
  | 'google-places';

export interface Payee {
  id: string;
  userId: string;
  name: string;
  defaultCategoryId: string | null;
  defaultCategory: Category | null;
  notes: string | null;
  /**
   * The payee's site, stored absolute (https unless an explicit http:// was
   * given), so it can go straight into an anchor.
   */
  website: string | null;
  /**
   * Whether a brand favicon is cached for this payee. The bytes never travel
   * in the payload -- they are served from `payeeLogoUrl(id)` -- so this flag
   * is what a list read answers "is there an icon?" with.
   */
  hasLogo: boolean;
  /** Last time the favicon was looked for, successfully or not. */
  logoFetchedAt: string | null;
  /** Free-text postal address. One field, not structured parts. */
  address: string | null;
  email: string | null;
  phone: string | null;
  /**
   * When a contact lookup last got an answer for this payee (found something,
   * or established there was nothing). Null until one has run.
   */
  contactLookupAt: string | null;
  /**
   * Which lookup wrote at least one of the contact fields; null when every
   * stored value was typed by the user. The "looked up automatically" badge
   * keys off this.
   */
  contactLookupSource: ContactLookupSource | null;
  isActive: boolean;
  createdAt: string;
  transactionCount?: number;
  lastUsedDate?: string | null;
  aliasCount?: number;
  uncategorizedCount?: number;
}

/**
 * One account the payee has been transacted from, in the account's own
 * currency. Mirrors the backend's PayeeAccountBreakdownRow.
 */
export interface PayeeAccountBreakdownRow {
  accountId: string;
  accountName: string;
  accountType: string;
  currencyCode: string;
  transactionCount: number;
  total: number;
  lastTransactionDate: string | null;
}

/** The payee's single largest transaction by absolute amount. */
export interface PayeeLargestTransaction {
  id: string;
  transactionDate: string;
  amount: number;
  currencyCode: string;
  accountId: string;
  accountName: string;
  description: string | null;
}

/** Lifetime facts computed over real (non-void, non-split-child) transactions. */
export interface PayeeDetailStats {
  transactionCount: number;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  uncategorizedCount: number;
  aliasCount: number;
}

/** The detail-page aggregate from GET /payees/:id/detail. */
export interface PayeeDetail {
  payee: Payee;
  stats: PayeeDetailStats;
  accounts: PayeeAccountBreakdownRow[];
  largestTransaction: PayeeLargestTransaction | null;
  overpaymentForAccounts: { accountId: string; accountName: string }[];
}

export interface PayeeAlias {
  id: string;
  payeeId: string;
  userId: string;
  alias: string;
  createdAt: string;
  payee?: Payee;
}

/** Why a contact lookup did or did not produce a suggestion. */
export type ContactLookupReason = 'ok' | 'none' | 'disabled' | 'no_provider' | 'failed';

export type ContactLookupField = 'website' | 'address' | 'email' | 'phone';
export const CONTACT_LOOKUP_FIELDS: readonly ContactLookupField[] = [
  'website',
  'address',
  'email',
  'phone',
];

export interface PayeeContactSuggestion {
  website: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  source: ContactLookupSource;
  confidence: 'high' | 'medium' | 'low' | null;
  notes: string | null;
}

/**
 * `POST /payees/lookup-contact`. Always a 200: `reason` says what happened,
 * and only `failed` may carry a `detail` the user can act on (their relay
 * agent is offline, for instance). A `failed` is never "nothing found".
 */
export interface PayeeContactLookupResult {
  reason: ContactLookupReason;
  suggestion: PayeeContactSuggestion | null;
  detail?: string;
}

/** `POST /payees/:id/lookup-contact`: which fields this run filled in. */
export interface PayeeContactRerunResult {
  reason: ContactLookupReason;
  detail?: string;
  filled: ContactLookupField[];
  payee: Payee;
}

export interface CreatePayeeData {
  name: string;
  defaultCategoryId?: string;
  notes?: string;
  /** Accepts a bare domain; the backend stores it absolute. */
  website?: string | null;
  /**
   * Contact details. An empty string clears the stored value, which is what a
   * form field the user emptied sends; omitting the key leaves it alone.
   */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

export type ApplyCategoryToTransactions = 'none' | 'uncategorized' | 'all';

export interface UpdatePayeeData extends Partial<CreatePayeeData> {
  isActive?: boolean;
  applyCategoryToTransactions?: ApplyCategoryToTransactions;
}

export interface CreatePayeeAliasData {
  payeeId: string;
  alias: string;
}

export interface MergePayeeData {
  targetPayeeId: string;
  sourcePayeeId: string;
  addAsAlias?: boolean;
}

export interface MergePayeeResult {
  transactionsMigrated: number;
  aliasAdded: boolean;
  sourcePayeeDeleted: boolean;
}

export type CategoryMatchMode = 'off' | 'category' | 'subcategory';

export interface AutoMergePreviewParams {
  minGroupSize: number;
  similarityThreshold: number;
  minTokenLength: number;
  includeInactive: boolean;
  categoryMatch: CategoryMatchMode;
  ignoreCommonWords: boolean;
  commonWordMinVariants: number;
}

export interface AutoMergeMember {
  payeeId: string;
  name: string;
  transactionCount: number;
  isCanonical: boolean;
}

export interface AutoMergeGroup {
  groupKey: string;
  suggestedCanonicalPayeeId: string;
  suggestedName: string;
  suggestedAlias: string;
  suggestedCategoryId: string | null;
  uncategorizedTransactionCount: number;
  members: AutoMergeMember[];
  totalTransactions: number;
}

export interface ApplyAutoMergeGroup {
  canonicalPayeeId: string;
  canonicalName?: string;
  sourcePayeeIds: string[];
  alias?: string;
  defaultCategoryId?: string;
  backfillTransactions?: boolean;
}

export interface ApplyAutoMergeFailure {
  canonicalPayeeId: string;
  canonicalName: string;
  conflictingValue: string | null;
  reason: string;
}

export interface ApplyAutoMergeSkippedAlias {
  canonicalPayeeId: string;
  canonicalName: string;
  alias: string;
}

export interface ApplyAutoMergeResult {
  groupsMerged: number;
  payeesMerged: number;
  transactionsMigrated: number;
  aliasesCreated: number;
  skippedAliases: number;
  transactionsBackfilled: number;
  skippedAliasDetails: ApplyAutoMergeSkippedAlias[];
  failures: ApplyAutoMergeFailure[];
}

export interface PayeeSummary {
  totalPayees: number;
  payeesWithCategory: number;
  payeesWithoutCategory: number;
  activePayees: number;
  inactivePayees: number;
}

export interface CategorySuggestion {
  payeeId: string;
  payeeName: string;
  currentCategoryId: string | null;
  currentCategoryName: string | null;
  suggestedCategoryId: string;
  suggestedCategoryName: string;
  transactionCount: number;
  categoryCount: number;
  percentage: number;
  uncategorizedCount: number;
}

export interface CategorySuggestionsParams {
  minTransactions: number;
  minPercentage: number;
  onlyWithoutCategory?: boolean;
}

export interface CategoryAssignment {
  payeeId: string;
  categoryId: string;
  backfillTransactions?: boolean;
}

export interface DeactivationPreviewParams {
  maxTransactions: number;
  monthsUnused: number;
}

export interface DeactivationCandidate {
  payeeId: string;
  payeeName: string;
  transactionCount: number;
  lastUsedDate: string | null;
  defaultCategoryName: string | null;
}

export type PayeeStatusFilter = 'active' | 'inactive' | 'all';

export type PayeeCategoryFilter = 'all' | 'noDefaultCategory' | 'uncategorizedTransactions';
