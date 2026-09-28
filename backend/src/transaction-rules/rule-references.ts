import { EntityManager, EntityTarget, FindOptionsWhere, In } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { RuleAction } from "./rule-action.types";
import {
  RULE_CONDITION_FIELDS,
  RuleConditionNode,
} from "./rule-condition.types";
import {
  RuleReferencedIds,
  RuleValidationCode,
  collectReferencedIds,
} from "./rule-validation";

/** A validation code, or the one the ownership check adds. */
export type RuleErrorCode = RuleValidationCode | "REFERENCE_NOT_FOUND";

export interface RuleErrorEntry {
  readonly path: string;
  readonly code: RuleErrorCode;
}

/** Which table a referenced id is looked up in. */
type ReferenceKind = keyof RuleReferencedIds;

interface ReferenceSite {
  /** The leaf or action that names the ids (`condition.all[0]`, `actions[1]`). */
  readonly path: string;
  readonly kind: ReferenceKind;
  readonly ids: readonly string[];
}

const KIND_BY_VALUE_KIND: Readonly<Record<string, ReferenceKind>> = {
  accountId: "accountIds",
  payeeId: "payeeIds",
  categoryId: "categoryIds",
  tagIds: "tagIds",
};

const toList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === "string",
  );

/**
 * `set_category` / `set_payee` default to `onlyIfEmpty: true` (design section
 * 3, decision 3); the validator requires the flag present, so the default is
 * applied before it. Returns a new array; anything that is not a plain action
 * object is passed through for the validator to report.
 */
export function withActionDefaults(actions: unknown): unknown {
  if (!Array.isArray(actions)) return actions;
  return actions.map((action) => {
    if (
      typeof action === "object" &&
      action !== null &&
      !Array.isArray(action) &&
      ((action as { type?: unknown }).type === "set_category" ||
        (action as { type?: unknown }).type === "set_payee") &&
      (action as { onlyIfEmpty?: unknown }).onlyIfEmpty === undefined
    ) {
      return { ...(action as object), onlyIfEmpty: true };
    }
    return action;
  });
}

function conditionSites(
  node: RuleConditionNode,
  path: string,
  out: ReferenceSite[],
): void {
  if ("all" in node || "any" in node) {
    const key = "all" in node ? "all" : "any";
    const children = "all" in node ? node.all : node.any;
    children.forEach((child, i) =>
      conditionSites(child, `${path}.${key}[${i}]`, out),
    );
    return;
  }
  const kind = KIND_BY_VALUE_KIND[RULE_CONDITION_FIELDS[node.field].kind];
  if (kind && node.value !== undefined) {
    out.push({ path, kind, ids: toList(node.value) });
  }
}

function actionSites(
  actions: readonly RuleAction[],
  out: ReferenceSite[],
): void {
  actions.forEach((action, i) => {
    const path = `actions[${i}]`;
    if (action.type === "set_category") {
      out.push({ path, kind: "categoryIds", ids: [action.categoryId] });
    } else if (action.type === "set_payee") {
      out.push({ path, kind: "payeeIds", ids: [action.payeeId] });
    } else if (action.type !== "request_ai_review") {
      out.push({ path, kind: "tagIds", ids: [...action.tagIds] });
    }
  });
}

/**
 * The ids of `ids` that do not exist for `userId`, per kind. Runs on the
 * caller's manager so it shares the write's transaction. Every query is
 * scoped by `userId`, so another user's id is reported exactly like a missing
 * one.
 */
export async function findMissingReferences(
  m: EntityManager,
  userId: string,
  ids: RuleReferencedIds,
): Promise<RuleReferencedIds> {
  const missing = async <T extends { id: string }>(
    entity: EntityTarget<T>,
    wanted: readonly string[],
  ): Promise<string[]> => {
    if (wanted.length === 0) return [];
    const found = await m.getRepository(entity).find({
      select: { id: true } as never,
      where: { id: In([...wanted]), userId } as unknown as FindOptionsWhere<T>,
    });
    const present = new Set(found.map((row) => row.id));
    return wanted.filter((id) => !present.has(id));
  };
  return {
    accountIds: await missing(Account, ids.accountIds),
    payeeIds: await missing(Payee, ids.payeeIds),
    categoryIds: await missing(Category, ids.categoryIds),
    tagIds: await missing(Tag, ids.tagIds),
  };
}

/**
 * One `REFERENCE_NOT_FOUND` per leaf or action that names an id in `missing`,
 * at the path of that leaf or action so the editor can point at its card.
 * `definition` must already have passed `validateRuleDefinition`.
 */
export function referenceErrors(
  definition: { condition: RuleConditionNode; actions: readonly RuleAction[] },
  missing: RuleReferencedIds,
): RuleErrorEntry[] {
  const sites: ReferenceSite[] = [];
  conditionSites(definition.condition, "condition", sites);
  actionSites(definition.actions, sites);
  const lost = {
    accountIds: new Set(missing.accountIds),
    payeeIds: new Set(missing.payeeIds),
    categoryIds: new Set(missing.categoryIds),
    tagIds: new Set(missing.tagIds),
  };
  return sites
    .filter((site) => site.ids.some((id) => lost[site.kind].has(id)))
    .map((site) => ({
      path: site.path,
      code: "REFERENCE_NOT_FOUND" as const,
    }));
}

/** Every referenced id of a valid definition, and the ones that do not exist. */
export async function checkReferences(
  m: EntityManager,
  userId: string,
  definition: { condition: RuleConditionNode; actions: readonly RuleAction[] },
): Promise<RuleErrorEntry[]> {
  const ids = collectReferencedIds(definition);
  const missing = await findMissingReferences(m, userId, ids);
  return referenceErrors(definition, missing);
}
