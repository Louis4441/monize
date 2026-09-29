import { RuleEffectsLabels } from "./transaction-rules-applier.service";

/** The filters of a manual run or a test, as the service reads them. */
export interface RuleRunFilters {
  readonly accountIds?: readonly string[];
  readonly startDate?: string;
  readonly endDate?: string;
  readonly limit?: number;
}

/** Why a row the rule reached was left alone. */
export type RuleRunSkipReason =
  | "reconciled_locked"
  | "transfer_leg_category"
  | "split_category"
  | "cross_owner_transfer_payee";

/** `{field: {before, after}}`, the shape the trace stores. */
export type RuleRunChanges = Readonly<
  Record<string, { readonly before: unknown; readonly after: unknown }>
>;

export interface RuleRunMatchedRow {
  /** For a same-owner transfer: the outgoing leg; the mirror leg gets the same change. */
  readonly transactionId: string;
  readonly date: string;
  readonly payeeName: string | null;
  readonly amount: number;
  readonly currencyCode: string;
  readonly changes: RuleRunChanges;
}

export interface RuleRunSkippedRow {
  readonly transactionId: string;
  readonly reason: RuleRunSkipReason;
}

/** What `preview-run` and `preview-draft` return: exactly what the commit would write. */
export interface RuleRunPreview {
  readonly matched: RuleRunMatchedRow[];
  readonly skipped: RuleRunSkippedRow[];
  /** Transactions examined (a same-owner transfer counts once). */
  readonly scanned: number;
  /** More rows matched the filters than `limit` allowed. */
  readonly truncated: boolean;
  /** Hash of the planned changes and the rule revision; the commit must echo it. */
  readonly fingerprint: string;
  readonly labels: RuleEffectsLabels;
}

export interface RuleRunResult {
  /** Rows written (both legs of a same-owner transfer count). */
  readonly changed: number;
  readonly skipped: RuleRunSkippedRow[];
  /** The single action-history entry, or null when nothing changed or it could not be recorded. */
  readonly historyId: string | null;
}

export interface RuleApplicationRow {
  readonly id: string;
  readonly transactionId: string;
  readonly date: string;
  readonly payeeName: string | null;
  readonly amount: number;
  readonly currencyCode: string;
  readonly source: string;
  readonly changes: Record<string, unknown>;
  readonly appliedAt: Date;
}
