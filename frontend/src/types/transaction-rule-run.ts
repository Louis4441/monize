/**
 * The shapes of the rule test and manual-run endpoints. Mirrors
 * `backend/src/transaction-rules/rule-run.types.ts` and
 * `dto/rule-run.dto.ts`.
 */
import type { RuleAction, RuleConditionNode } from '@/types/transaction-rule';

/** Which existing transactions a test or a manual run looks at. */
export interface RuleRunFilters {
  accountIds?: string[];
  /** Inclusive, YYYY-MM-DD. */
  startDate?: string;
  /** Inclusive, YYYY-MM-DD. */
  endDate?: string;
  /** Newest rows examined. */
  limit?: number;
}

export interface RuleRunFieldChange<T> {
  before: T;
  after: T;
}

/** What a rule changed on one row; an absent key was left alone. */
export interface RuleRunChanges {
  categoryId?: RuleRunFieldChange<string | null>;
  payeeId?: RuleRunFieldChange<string | null>;
  /** Set by `set_payee_from_text`: the name the payee is written with. */
  payeeName?: RuleRunFieldChange<string | null>;
  /** True when the payee does not exist yet and the run will create it. */
  payeeCreated?: boolean;
  /** Set by `set_description`. */
  description?: RuleRunFieldChange<string | null>;
  /** The tag id sets before and after. */
  tagIds?: RuleRunFieldChange<string[]>;
}

export interface RuleRunMatchedRow {
  transactionId: string;
  date: string;
  payeeName: string | null;
  amount: number;
  currencyCode: string;
  changes: RuleRunChanges;
}

export type RuleRunSkipReason =
  | 'reconciled_locked'
  | 'transfer_leg_category'
  | 'split_category'
  | 'cross_owner_transfer_payee'
  | 'empty_render'
  | 'payee_not_found';

export interface RuleRunSkippedRow {
  transactionId: string;
  reason: RuleRunSkipReason;
}

/** Names for the ids `changes` mentions, so no raw id reaches the screen. */
export interface RuleRunLabels {
  categories: Record<string, string>;
  payees: Record<string, string>;
  tags: Record<string, string>;
  rules: Record<string, string>;
}

export interface RuleRunPreview {
  matched: RuleRunMatchedRow[];
  skipped: RuleRunSkippedRow[];
  /** Transactions examined. */
  scanned: number;
  /**
   * Scanned transactions whose condition matched, whether or not anything would
   * change. Only 0 means the rule matches nothing; `matched` counts changes.
   */
  conditionMatchedCount: number;
  /** More rows matched the filters than `limit` allowed. */
  truncated: boolean;
  /** Echoed back by the run to confirm this exact plan. */
  fingerprint: string;
  labels: RuleRunLabels;
}

export interface RuleRunResult {
  /** Rows written. */
  changed: number;
  skipped: RuleRunSkippedRow[];
  /** The action-history entry, or null when nothing changed or it was not recorded. */
  historyId: string | null;
}

/** An unsaved rule to test. */
export interface PreviewDraftRuleData {
  /** The saved rule being edited; absent for a new rule. Lets the server skip authoring advice on an unchanged condition. */
  ruleId?: string;
  condition: RuleConditionNode;
  actions: RuleAction[];
  filters?: RuleRunFilters;
}

export type RuleApplicationSource = 'create' | 'import' | 'manual';

export interface RuleApplication {
  id: string;
  transactionId: string;
  date: string;
  payeeName: string | null;
  amount: number;
  currencyCode: string;
  /** A value newer than this client reads as unknown. */
  source: string;
  changes: RuleRunChanges;
  appliedAt: string;
}

/** Error codes the run endpoints answer with. */
export type RuleRunErrorCode =
  | 'PREVIEW_CHANGED'
  | 'RUN_TOO_LARGE'
  | 'INVALID_RULE'
  | 'DATE_RANGE_INVALID';
