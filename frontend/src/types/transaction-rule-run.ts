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
  | 'cross_owner_transfer_payee';

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
