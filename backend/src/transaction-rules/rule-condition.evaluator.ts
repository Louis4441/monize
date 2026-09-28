import { matchesAliasPattern } from "../payees/alias-match.util";
import {
  RULE_CONDITION_FIELDS,
  RuleConditionLeaf,
  RuleConditionNode,
  RuleFacts,
  RuleOperator,
} from "./rule-condition.types";

/** Money scale: rule literals and facts compare as integers in 1/10000 units. */
const MONEY_SCALE = 10000;

/** A rule literal as the scaled integer the facts use. */
export function scaleRuleMoney(value: unknown): number {
  return Math.round(Number(value) * MONEY_SCALE);
}

const normalize = (value: string): string => value.trim().toLowerCase();

const asList = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/**
 * Evaluate a condition tree against the facts of one row.
 *
 * Pure: no query, no clock, no `eval`. A group `all` of nothing is true and
 * `any` of nothing is false; `not` negates the group's result. A leaf whose
 * fact is unknown (`null`) is false for every operator except `isEmpty`.
 */
export function evaluateRuleCondition(
  node: RuleConditionNode,
  facts: RuleFacts,
): boolean {
  if ("all" in node) {
    const result = node.all.every((child) =>
      evaluateRuleCondition(child, facts),
    );
    return node.not === true ? !result : result;
  }
  if ("any" in node) {
    const result = node.any.some((child) =>
      evaluateRuleCondition(child, facts),
    );
    return node.not === true ? !result : result;
  }
  return evaluateLeaf(node, facts);
}

function evaluateLeaf(leaf: RuleConditionLeaf, facts: RuleFacts): boolean {
  const spec = RULE_CONDITION_FIELDS[leaf.field];
  if (spec === undefined || !spec.operators.includes(leaf.op as never)) {
    // A stored rule that no longer fits the table matches nothing.
    return false;
  }
  switch (spec.kind) {
    case "accountId":
    case "payeeId":
    case "categoryId":
      return evaluateId(leaf, facts);
    case "tagIds":
      return evaluateTags(leaf.op, facts.tagIds, asList(leaf.value));
    case "text":
      return evaluateText(leaf.op, textFact(leaf, facts), leaf.value);
    case "money":
      return evaluateMoney(leaf, facts);
    case "boolean":
      return leaf.op === "eq" && facts.hasSplits === leaf.value;
    default:
      // "enum" and "currency" compare as case-insensitive codes.
      return evaluateCode(
        leaf.op,
        leaf.field === "type" ? facts.type : facts.currencyCode,
        leaf.value,
      );
  }
}

function idFact(leaf: RuleConditionLeaf, facts: RuleFacts): string | null {
  switch (leaf.field) {
    case "accountId":
      return facts.accountId;
    case "fromAccountId":
      return facts.fromAccountId;
    case "toAccountId":
      return facts.toAccountId;
    case "payeeId":
      return facts.payeeId;
    default:
      return facts.categoryId;
  }
}

function textFact(leaf: RuleConditionLeaf, facts: RuleFacts): string | null {
  switch (leaf.field) {
    case "payeeText":
      return facts.payeeText;
    case "description":
      return facts.description;
    default:
      return facts.memo;
  }
}

function evaluateId(leaf: RuleConditionLeaf, facts: RuleFacts): boolean {
  const fact = idFact(leaf, facts);
  if (fact === null) return leaf.op === "isEmpty";
  switch (leaf.op) {
    case "eq":
      return fact === leaf.value;
    case "neq":
      return fact !== leaf.value;
    case "in":
      return asList(leaf.value).includes(fact);
    case "notIn":
      return !asList(leaf.value).includes(fact);
    case "inSubtree":
      return facts.categoryAncestorIds.includes(leaf.value as string);
    default:
      return false;
  }
}

function evaluateTags(
  op: RuleOperator,
  tagIds: readonly string[],
  wanted: readonly unknown[],
): boolean {
  switch (op) {
    case "hasAny":
      return wanted.some((id) => tagIds.includes(id as string));
    case "hasAll":
      return wanted.every((id) => tagIds.includes(id as string));
    default: // hasNone: the field table admits no other operator
      return !wanted.some((id) => tagIds.includes(id as string));
  }
}

function evaluateText(
  op: RuleOperator,
  fact: string | null,
  value: unknown,
): boolean {
  if (fact === null) return op === "isEmpty";
  const text = normalize(fact);
  if (op === "isEmpty") return text === "";
  if (typeof value !== "string") return false;
  const wanted = normalize(value);
  switch (op) {
    case "eq":
      return text === wanted;
    case "contains":
      return text.includes(wanted);
    case "startsWith":
      return text.startsWith(wanted);
    default: // matches: the field table admits no other operator
      return matchesAliasPattern(text, wanted);
  }
}

function evaluateMoney(leaf: RuleConditionLeaf, facts: RuleFacts): boolean {
  if (facts.amount === null) return false;
  const fact =
    leaf.field === "absAmount" ? Math.abs(facts.amount) : facts.amount;
  if (leaf.op === "between") {
    const [min, max] = asList(leaf.value);
    return fact >= scaleRuleMoney(min) && fact <= scaleRuleMoney(max);
  }
  const wanted = scaleRuleMoney(leaf.value);
  switch (leaf.op) {
    case "eq":
      return fact === wanted;
    case "lt":
      return fact < wanted;
    case "lte":
      return fact <= wanted;
    case "gt":
      return fact > wanted;
    default: // gte: the field table admits no other operator
      return fact >= wanted;
  }
}

function evaluateCode(
  op: RuleOperator,
  fact: string | null,
  value: unknown,
): boolean {
  if (fact === null) return false;
  const code = fact.trim().toUpperCase();
  const same = (v: unknown): boolean =>
    typeof v === "string" && v.trim().toUpperCase() === code;
  switch (op) {
    case "eq":
      return same(value);
    case "neq":
      return !same(value);
    default: // in: the field table admits no other operator
      return asList(value).some(same);
  }
}
