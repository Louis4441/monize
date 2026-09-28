import { RuleAction, isLedgerAction } from "./rule-action.types";
import { evaluateRuleCondition } from "./rule-condition.evaluator";
import { RuleConditionNode, RuleFacts } from "./rule-condition.types";
import { validateRuleDefinition } from "./rule-validation";

/** The part of a stored rule the planner reads. `TransactionRule` satisfies it. */
export interface PlannableRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly stopProcessing: boolean;
  readonly condition: RuleConditionNode;
  readonly actions: readonly RuleAction[];
}

export type RuleActionSkipReason =
  | "already_set"
  | "no_change"
  | "row_has_splits"
  | "row_is_transfer_leg"
  | "cross_owner_transfer_leg"
  | "ai_review_queue_unavailable";

export type RuleSkipReason = "disabled" | "invalid";

/** What the planner knows about the row beyond its facts. */
export interface RulePlanContext {
  /** The row is a leg of a transfer whose other leg belongs to another owner. */
  readonly crossOwnerTransferLeg?: boolean;
  /**
   * The category plus its ancestors for every category a rule may set, so a
   * later rule's `inSubtree` sees an earlier rule's category. The planner does
   * no I/O; a missing entry falls back to the category alone.
   */
  readonly categoryChains?: ReadonlyMap<string, readonly string[]>;
}

export interface RuleFieldChange<T> {
  readonly before: T;
  readonly after: T;
}

/** What one rule changed, in the `{field: {before, after}}` shape of the trace. */
export interface RuleTraceChanges {
  readonly categoryId?: RuleFieldChange<string | null>;
  readonly payeeId?: RuleFieldChange<string | null>;
  /** Sorted tag id sets before and after the rule. */
  readonly tagIds?: RuleFieldChange<readonly string[]>;
}

export interface RuleAppliedAction {
  readonly type: RuleAction["type"];
}

export interface RuleSkippedAction {
  readonly type: RuleAction["type"];
  readonly reason: RuleActionSkipReason;
}

export interface RuleTraceEntry {
  readonly ruleId: string;
  readonly matched: boolean;
  /** Set when the rule was not evaluated at all. */
  readonly skippedRule?: RuleSkipReason;
  readonly applied: readonly RuleAppliedAction[];
  readonly skipped: readonly RuleSkippedAction[];
  /** Ledger fields this rule changed (empty when it changed nothing). */
  readonly changes: RuleTraceChanges;
  /** True when this matched rule ended the pass (`stopProcessing`). */
  readonly stopped: boolean;
}

export interface AiReviewRequest {
  readonly ruleId: string;
  readonly instruction: string;
}

/** The net change to the row after every rule ran; absent means untouched. */
export interface RuleNetChanges {
  readonly categoryId?: string | null;
  readonly payeeId?: string | null;
  readonly addTagIds: readonly string[];
  readonly removeTagIds: readonly string[];
}

export interface RuleEffects {
  readonly changes: RuleNetChanges;
  readonly trace: readonly RuleTraceEntry[];
  readonly aiReviewRequests: readonly AiReviewRequest[];
}

/** The ledger fields rules move, threaded through the pass (never mutated). */
interface WorkingState {
  readonly categoryId: string | null;
  readonly categoryAncestorIds: readonly string[];
  readonly payeeId: string | null;
  readonly tagIds: readonly string[];
}

const NO_CHANGES: RuleTraceChanges = Object.freeze({});

function withState(facts: RuleFacts, state: WorkingState): RuleFacts {
  return Object.freeze({ ...facts, ...state });
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

interface StepResult {
  readonly state: WorkingState;
  readonly applied?: RuleAppliedAction;
  readonly skipped?: RuleSkippedAction;
}

function skip(
  state: WorkingState,
  action: RuleAction,
  reason: RuleActionSkipReason,
): StepResult {
  return { state, skipped: { type: action.type, reason } };
}

function refusal(
  action: RuleAction,
  facts: RuleFacts,
  context: RulePlanContext,
): RuleActionSkipReason | null {
  if (action.type === "set_category") {
    if (facts.hasSplits) return "row_has_splits";
    if (facts.type === "TRANSFER") return "row_is_transfer_leg";
  }
  if (action.type === "set_payee" && context.crossOwnerTransferLeg === true) {
    return "cross_owner_transfer_leg";
  }
  return null;
}

/** One ledger action against the working state (design 6.1, 6.4). */
function step(
  state: WorkingState,
  action: RuleAction,
  facts: RuleFacts,
  context: RulePlanContext,
): StepResult {
  const refused = refusal(action, facts, context);
  if (refused !== null) return skip(state, action, refused);
  switch (action.type) {
    case "set_category": {
      if (action.onlyIfEmpty && state.categoryId !== null) {
        return skip(state, action, "already_set");
      }
      if (state.categoryId === action.categoryId) {
        return skip(state, action, "no_change");
      }
      const chain = context.categoryChains?.get(action.categoryId);
      return {
        state: {
          ...state,
          categoryId: action.categoryId,
          categoryAncestorIds: chain ?? [action.categoryId],
        },
        applied: { type: action.type },
      };
    }
    case "set_payee":
      if (action.onlyIfEmpty && state.payeeId !== null) {
        return skip(state, action, "already_set");
      }
      if (state.payeeId === action.payeeId) {
        return skip(state, action, "no_change");
      }
      return {
        state: { ...state, payeeId: action.payeeId },
        applied: { type: action.type },
      };
    case "add_tags": {
      const added = [...new Set(action.tagIds)].filter(
        (id) => !state.tagIds.includes(id),
      );
      if (added.length === 0) return skip(state, action, "no_change");
      return {
        state: { ...state, tagIds: [...state.tagIds, ...added] },
        applied: { type: action.type },
      };
    }
    case "remove_tags": {
      const drop = new Set(action.tagIds);
      const kept = state.tagIds.filter((id) => !drop.has(id));
      if (kept.length === state.tagIds.length) {
        return skip(state, action, "no_change");
      }
      return {
        state: { ...state, tagIds: kept },
        applied: { type: action.type },
      };
    }
    default:
      // request_ai_review is collected by the caller, never a ledger step.
      return { state };
  }
}

function diffState(
  before: WorkingState,
  after: WorkingState,
): RuleTraceChanges {
  return {
    ...(before.categoryId !== after.categoryId
      ? {
          categoryId: { before: before.categoryId, after: after.categoryId },
        }
      : {}),
    ...(before.payeeId !== after.payeeId
      ? { payeeId: { before: before.payeeId, after: after.payeeId } }
      : {}),
    ...(!sameSet(before.tagIds, after.tagIds)
      ? {
          tagIds: {
            before: [...before.tagIds].sort(),
            after: [...after.tagIds].sort(),
          },
        }
      : {}),
  };
}

function isPlannable(rule: PlannableRule): RuleSkipReason | null {
  if (!rule.enabled) return "disabled";
  const problems = validateRuleDefinition({
    condition: rule.condition,
    actions: rule.actions,
  });
  return problems.length > 0 ? "invalid" : null;
}

function netChanges(first: WorkingState, last: WorkingState): RuleNetChanges {
  return {
    ...(first.categoryId !== last.categoryId
      ? { categoryId: last.categoryId }
      : {}),
    ...(first.payeeId !== last.payeeId ? { payeeId: last.payeeId } : {}),
    addTagIds: last.tagIds.filter((id) => !first.tagIds.includes(id)),
    removeTagIds: first.tagIds.filter((id) => !last.tagIds.includes(id)),
  };
}

/**
 * Plan what the rules would do to one row. Pure: no query, no clock. `rules`
 * are in `position` order; a disabled or invalid rule is traced and skipped;
 * a later rule sees the facts an earlier rule changed (sequential, one pass,
 * design 3.5); a matched rule with `stopProcessing` ends the pass. A refused
 * action is skipped with its reason and the rest of the rule still runs.
 *
 * `request_ai_review` is collected into `aiReviewRequests` and is never a
 * ledger change. The preview, the test panel and the commit all call this one
 * function (INV-RULE-003 / design I3).
 */
export function planRuleEffects(
  facts: RuleFacts,
  rules: readonly PlannableRule[],
  context: RulePlanContext = {},
): RuleEffects {
  const initial: WorkingState = {
    categoryId: facts.categoryId,
    categoryAncestorIds: facts.categoryAncestorIds,
    payeeId: facts.payeeId,
    tagIds: facts.tagIds,
  };
  let state = initial;
  const trace: RuleTraceEntry[] = [];
  const aiReviewRequests: AiReviewRequest[] = [];

  for (const rule of rules) {
    const notRun = isPlannable(rule);
    if (notRun !== null) {
      trace.push({
        ruleId: rule.id,
        matched: false,
        skippedRule: notRun,
        applied: [],
        skipped: [],
        changes: NO_CHANGES,
        stopped: false,
      });
      continue;
    }
    if (!evaluateRuleCondition(rule.condition, withState(facts, state))) {
      trace.push({
        ruleId: rule.id,
        matched: false,
        applied: [],
        skipped: [],
        changes: NO_CHANGES,
        stopped: false,
      });
      continue;
    }

    const before = state;
    const applied: RuleAppliedAction[] = [];
    const skipped: RuleSkippedAction[] = [];
    for (const action of rule.actions) {
      if (!isLedgerAction(action)) {
        aiReviewRequests.push({
          ruleId: rule.id,
          instruction: action.instruction,
        });
        continue;
      }
      const result = step(state, action, withState(facts, state), context);
      state = result.state;
      if (result.applied) applied.push(result.applied);
      if (result.skipped) skipped.push(result.skipped);
    }
    trace.push({
      ruleId: rule.id,
      matched: true,
      applied,
      skipped,
      changes: diffState(before, state),
      stopped: rule.stopProcessing,
    });
    if (rule.stopProcessing) break;
  }

  return {
    changes: netChanges(initial, state),
    trace,
    aiReviewRequests,
  };
}

/**
 * Until the AI review queue exists (task R1) a collected `request_ai_review`
 * cannot be enqueued, so the trace says so on the rule that asked. The
 * applier and the preview both pass the plan through this, so the two show
 * the same trace.
 */
export function recordAiReviewQueueUnavailable(
  effects: RuleEffects,
): RuleEffects {
  if (effects.aiReviewRequests.length === 0) return effects;
  const asked = new Set(effects.aiReviewRequests.map((r) => r.ruleId));
  return {
    ...effects,
    trace: effects.trace.map((entry) =>
      asked.has(entry.ruleId)
        ? {
            ...entry,
            skipped: [
              ...entry.skipped,
              {
                type: "request_ai_review" as const,
                reason: "ai_review_queue_unavailable" as const,
              },
            ],
          }
        : entry,
    ),
  };
}

/** True when the plan changes the row or asks for anything. */
export function hasRuleEffects(effects: RuleEffects): boolean {
  const { changes } = effects;
  return (
    changes.categoryId !== undefined ||
    changes.payeeId !== undefined ||
    changes.addTagIds.length > 0 ||
    changes.removeTagIds.length > 0 ||
    effects.aiReviewRequests.length > 0 ||
    effects.trace.some((entry) => entry.matched)
  );
}
