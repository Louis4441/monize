/**
 * The closed list of rule actions (design section 6.1). No action can change
 * an amount, an account, a date, a status, a split or a link, so a rule cannot
 * move a balance (INV-RULE-001): anything not in this union is not
 * representable, and the validator refuses it.
 *
 * `request_ai_review` is the one action that is not a ledger write: it asks
 * for a person-approved AI review of the row and never changes the row itself.
 * `isLedgerAction` tells the two groups apart for the applier.
 */

export const RULE_ACTION_TYPES = [
  "add_tags",
  "remove_tags",
  "set_category",
  "set_payee",
  "request_ai_review",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

export interface AddTagsAction {
  readonly type: "add_tags";
  readonly tagIds: readonly string[];
}

export interface RemoveTagsAction {
  readonly type: "remove_tags";
  readonly tagIds: readonly string[];
}

export interface SetCategoryAction {
  readonly type: "set_category";
  readonly categoryId: string;
  readonly onlyIfEmpty: boolean;
}

export interface SetPayeeAction {
  readonly type: "set_payee";
  readonly payeeId: string;
  readonly onlyIfEmpty: boolean;
}

export interface RequestAiReviewAction {
  readonly type: "request_ai_review";
  /** What the user wants checked, e.g. "split this purchase by the receipt". */
  readonly instruction: string;
}

/** The actions that change the row's tags, category or payee. */
export type LedgerRuleAction =
  | AddTagsAction
  | RemoveTagsAction
  | SetCategoryAction
  | SetPayeeAction;

export type RuleAction = LedgerRuleAction | RequestAiReviewAction;

/** True for an action that writes to the ledger; false for `request_ai_review`. */
export function isLedgerAction(action: RuleAction): action is LedgerRuleAction {
  return action.type !== "request_ai_review";
}
