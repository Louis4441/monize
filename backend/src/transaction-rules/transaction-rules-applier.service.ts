import { Injectable } from "@nestjs/common";
import { ArrayContains, EntityManager, In } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TagsService } from "../tags/tags.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import {
  PlannableRule,
  RuleEffects,
  RulePlanContext,
  hasRuleEffects,
  planRuleEffects,
  recordAiReviewQueueUnavailable,
} from "./rule-effects";
import {
  RuleFactsInput,
  buildRuleFacts,
  loadCategoryChains,
} from "./rule-facts";
import { toRuleResponses } from "./transaction-rule-view";
import {
  RuleApplicationSource,
  TransactionRuleApplication,
} from "./transaction-rule-application.entity";
import { TransactionRule } from "./transaction-rule.entity";
import { RuleTrigger } from "./rule-trigger.types";

/** What the applier changed on one row. */
export interface AppliedRuleRow {
  readonly transactionId: string;
  readonly effects: RuleEffects;
}

/** The two stored legs of a transfer just written, and who owns each. */
export interface NewTransferLegs {
  readonly fromLegId: string;
  readonly toLegId: string;
  readonly fromOwnerId: string;
  readonly toOwnerId: string;
}

export interface ApplyToNewOptions {
  /** Rules already loaded for this call (an import loads them once per file). */
  readonly rules?: readonly TransactionRule[];
  /**
   * The raw payee text per transaction id, when the source has it. A row not
   * named here falls back to its stored `payee_name`.
   */
  readonly payeeTextById?: ReadonlyMap<string, string | null>;
}

/**
 * Names for the ids in a preview, so a confirmation card shows a category, a
 * payee, a tag and a rule by name and never an id.
 */
export interface RuleEffectsLabels {
  readonly categories: Readonly<Record<string, string>>;
  readonly payees: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly rules: Readonly<Record<string, string>>;
}

/** The plan a preview returns: exactly what the commit will write, plus names. */
export interface RuleEffectsPreview extends RuleEffects {
  readonly labels: RuleEffectsLabels;
}

/** The facts of a row that is not stored yet (the preview) or just stored. */
export type RuleRowInput = Omit<RuleFactsInput, "categoryAncestorIds">;

/**
 * Applies a user's transaction rules to rows in the caller's transaction
 * (design 6.3). It never opens its own transaction: every read and write goes
 * through the `EntityManager` it is handed, so a rollback of the insert rolls
 * back the rule effects (INV-RULE-002). It changes only category, payee and
 * tags -- never amount, account, date, status or a link (INV-RULE-001).
 */
@Injectable()
export class TransactionRulesApplierService {
  constructor(private readonly tagsService: TagsService) {}

  /**
   * The user's enabled rules for a trigger, in `position` order, without the
   * ones that no longer validate or name an id that is gone (the trace of such
   * a rule would only say "invalid").
   */
  async loadRulesFor(
    m: EntityManager,
    userId: string,
    trigger: RuleTrigger,
  ): Promise<TransactionRule[]> {
    const rules = await m.getRepository(TransactionRule).find({
      where: { userId, enabled: true, triggers: ArrayContains([trigger]) },
      order: { position: "ASC" },
    });
    if (rules.length === 0) return [];
    const views = await toRuleResponses(m, userId, rules);
    const usable = new Set(views.filter((v) => !v.invalid).map((v) => v.id));
    return rules.filter((rule) => usable.has(rule.id));
  }

  /**
   * Plan one row that is not (or not yet) stored. The one planning path: the
   * preview calls it directly and `applyToNew` calls it per stored row, so a
   * preview shows what the commit writes (design I3).
   */
  async planForRow(
    m: EntityManager,
    userId: string,
    input: RuleRowInput,
    rules: readonly TransactionRule[],
    context: Pick<RulePlanContext, "crossOwnerTransferLeg"> = {},
  ): Promise<RuleEffects> {
    if (rules.length === 0) return planRuleEffects(buildRuleFacts(input), []);
    const chains = await this.chainsFor(m, userId, rules, [input.categoryId]);
    return this.planWithChains(input, rules, chains, context);
  }

  /**
   * The preview of a create: the plan for a row that is not stored, or null
   * when the user has no rule for the trigger or nothing matched. It loads the
   * rules and plans through `planForRow`, the same path `applyToNew` uses.
   */
  async previewForRow(
    m: EntityManager,
    userId: string,
    input: RuleRowInput,
    trigger: RuleTrigger = "create",
  ): Promise<RuleEffectsPreview | null> {
    const rules = await this.loadRulesFor(m, userId, trigger);
    if (rules.length === 0) return null;
    const effects = await this.planForRow(m, userId, input, rules);
    if (!hasRuleEffects(effects)) return null;
    return {
      ...effects,
      labels: await this.labelsFor(m, userId, effects, rules),
    };
  }

  /** Names for the ids the effects and their traces mention (public: the manual run labels a whole batch). */
  async labelsFor(
    m: EntityManager,
    userId: string,
    effects: RuleEffects,
    rules: readonly (PlannableRule & { name?: string })[],
  ): Promise<RuleEffectsLabels> {
    const categoryIds = new Set<string>();
    const payeeIds = new Set<string>();
    const tagIds = new Set<string>([
      ...effects.changes.addTagIds,
      ...effects.changes.removeTagIds,
    ]);
    for (const entry of effects.trace) {
      const { categoryId, payeeId, tagIds: tags } = entry.changes;
      for (const id of [categoryId?.before, categoryId?.after])
        if (id) categoryIds.add(id);
      for (const id of [payeeId?.before, payeeId?.after])
        if (id) payeeIds.add(id);
      for (const id of [...(tags?.before ?? []), ...(tags?.after ?? [])])
        tagIds.add(id);
    }
    const names = async (
      entity: typeof Category | typeof Payee | typeof Tag,
      ids: Set<string>,
    ): Promise<Record<string, string>> => {
      if (ids.size === 0) return {};
      const found = (await m.find(entity as typeof Category, {
        select: { id: true, name: true },
        where: { id: In([...ids]), userId },
      })) as Array<{ id: string; name: string }>;
      return Object.fromEntries(found.map((row) => [row.id, row.name]));
    };
    return {
      categories: await names(Category, categoryIds),
      payees: await names(Payee, payeeIds),
      tags: await names(Tag, tagIds),
      rules: Object.fromEntries(
        rules
          .filter((rule) =>
            effects.trace.some((e) => e.ruleId === rule.id && e.matched),
          )
          .map((rule) => [rule.id, rule.name ?? rule.id]),
      ),
    };
  }

  /**
   * Apply the rules to rows just written in the caller's transaction. Returns
   * the rows a rule changed. Nothing is loaded or written when the user has no
   * rule for the trigger.
   */
  async applyToNew(
    m: EntityManager,
    userId: string,
    transactionIds: readonly string[],
    source: RuleApplicationSource,
    options: ApplyToNewOptions = {},
  ): Promise<AppliedRuleRow[]> {
    const ids = [...new Set(transactionIds)];
    if (ids.length === 0) return [];
    const rules =
      options.rules ??
      (await this.loadRulesFor(
        m,
        userId,
        source === "import" ? "import" : "create",
      ));
    if (rules.length === 0) return [];

    const rows = await m.find(Transaction, { where: { id: In(ids), userId } });
    const tagsByRow = await this.loadTagIds(m, ids);
    const chains = await this.chainsFor(
      m,
      userId,
      rules,
      rows.map((row) => row.categoryId),
    );

    const applied: AppliedRuleRow[] = [];
    for (const row of rows) {
      const { input, context } = await this.inputFromRow(
        m,
        userId,
        row,
        tagsByRow.get(row.id) ?? [],
        options.payeeTextById,
      );
      const effects = this.planWithChains(input, rules, chains, context);
      await this.writeEffects(m, userId, row.id, effects, source);
      applied.push({ transactionId: row.id, effects });
    }
    return applied;
  }

  /**
   * Apply the `create` rules to the legs of a transfer just written in the
   * caller's transaction (design 6.3). One evaluation per transfer per owner:
   *
   * - Same owner: evaluated once over the outgoing leg's facts, and the
   *   result is written to BOTH legs (tags mirrored the way `syncTransferTags`
   *   does, the payee on both). `set_category` is refused by the planner.
   * - Cross owner: each owner's rules run on that owner's leg only, and the
   *   other owner's leg is never read or written. The partner account is not
   *   put in the facts, and `set_payee` is refused (`crossOwnerTransferLeg`).
   *
   * Nothing is written when the owner has no rule for the trigger.
   */
  async applyToNewTransfer(
    m: EntityManager,
    legs: NewTransferLegs,
  ): Promise<AppliedRuleRow[]> {
    const sameOwner = legs.fromOwnerId === legs.toOwnerId;
    const applied: AppliedRuleRow[] = [];
    const evaluations: Array<{ ownerId: string; legIds: string[] }> = sameOwner
      ? [{ ownerId: legs.fromOwnerId, legIds: [legs.fromLegId, legs.toLegId] }]
      : [
          { ownerId: legs.fromOwnerId, legIds: [legs.fromLegId] },
          { ownerId: legs.toOwnerId, legIds: [legs.toLegId] },
        ];
    for (const { ownerId, legIds } of evaluations) {
      const rules = await this.loadRulesFor(m, ownerId, "create");
      if (rules.length === 0) continue;
      const rows = await m.find(Transaction, {
        where: { id: In(legIds), userId: ownerId },
      });
      const from = rows.find((row) => row.id === legs.fromLegId);
      const to = rows.find((row) => row.id === legs.toLegId);
      const primary = from ?? to;
      if (!primary) continue;
      const tagIds = (await this.loadTagIds(m, [primary.id])).get(primary.id);
      const chains = await this.chainsFor(m, ownerId, rules, [
        primary.categoryId,
      ]);
      const effects = this.planWithChains(
        {
          accountId: primary.accountId,
          currencyCode: primary.currencyCode,
          amount: primary.amount,
          isTransfer: true,
          fromAccountId: from?.accountId ?? null,
          toAccountId: to?.accountId ?? null,
          payeeId: primary.payeeId,
          payeeText: primary.payeeName,
          categoryId: primary.categoryId,
          description: primary.description,
          tagIds: tagIds ?? [],
          hasSplits: primary.isSplit,
        },
        rules,
        chains,
        { crossOwnerTransferLeg: !sameOwner },
      );
      for (const row of rows) {
        await this.writeEffects(m, ownerId, row.id, effects, "create");
        applied.push({ transactionId: row.id, effects });
      }
    }
    return applied;
  }

  planWithChains(
    input: RuleRowInput,
    rules: readonly PlannableRule[],
    chains: ReadonlyMap<string, readonly string[]>,
    context: Pick<RulePlanContext, "crossOwnerTransferLeg">,
  ): RuleEffects {
    const facts = buildRuleFacts({
      ...input,
      categoryAncestorIds:
        input.categoryId === null ? [] : chains.get(input.categoryId),
    });
    return recordAiReviewQueueUnavailable(
      planRuleEffects(facts, rules, {
        ...context,
        categoryChains: chains,
      }),
    );
  }

  /** One query for the chains of the rows' categories and of every category a rule sets. */
  chainsFor(
    m: EntityManager,
    userId: string,
    rules: readonly PlannableRule[],
    rowCategoryIds: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const wanted = new Set<string>();
    for (const id of rowCategoryIds) if (id) wanted.add(id);
    for (const rule of rules) {
      for (const action of rule.actions) {
        if (action.type === "set_category") wanted.add(action.categoryId);
      }
    }
    return loadCategoryChains(m, userId, [...wanted]);
  }

  async loadTagIds(
    m: EntityManager,
    transactionIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const links = await m.find(TransactionTag, {
      where: { transactionId: In([...transactionIds]) },
    });
    const byRow = new Map<string, string[]>();
    for (const link of links) {
      byRow.set(link.transactionId, [
        ...(byRow.get(link.transactionId) ?? []),
        link.tagId,
      ]);
    }
    return byRow;
  }

  /**
   * The facts input of a stored row. A transfer leg also needs the other
   * leg's account to say which way the money went; a partner leg the caller's
   * scope cannot read is another owner's, and the row is then treated as a
   * cross-owner leg (the safe side: `set_payee` is refused).
   */
  private async inputFromRow(
    m: EntityManager,
    userId: string,
    row: Transaction,
    tagIds: readonly string[],
    payeeTextById: ReadonlyMap<string, string | null> | undefined,
  ): Promise<{
    input: RuleRowInput;
    context: Pick<RulePlanContext, "crossOwnerTransferLeg">;
  }> {
    let fromAccountId: string | null = null;
    let toAccountId: string | null = null;
    let crossOwnerTransferLeg = false;
    if (row.isTransfer) {
      const partner = row.linkedTransactionId
        ? await m.findOne(Transaction, {
            where: { id: row.linkedTransactionId, userId },
          })
        : null;
      crossOwnerTransferLeg = partner === null;
      const outgoing = Number(row.amount) < 0;
      fromAccountId = outgoing ? row.accountId : (partner?.accountId ?? null);
      toAccountId = outgoing ? (partner?.accountId ?? null) : row.accountId;
    }
    return {
      input: {
        accountId: row.accountId,
        currencyCode: row.currencyCode,
        amount: row.amount,
        isTransfer: row.isTransfer,
        fromAccountId,
        toAccountId,
        payeeId: row.payeeId,
        payeeText: payeeTextById?.has(row.id)
          ? (payeeTextById.get(row.id) ?? null)
          : row.payeeName,
        categoryId: row.categoryId,
        description: row.description,
        tagIds,
        hasSplits: row.isSplit,
      },
      context: { crossOwnerTransferLeg },
    };
  }

  /** Category and payee through the manager's parameterized UPDATE, tags through TagsService, one trace row per rule. */
  async writeEffects(
    m: EntityManager,
    userId: string,
    transactionId: string,
    effects: RuleEffects,
    source: RuleApplicationSource,
  ): Promise<void> {
    const { changes } = effects;
    const patch: Partial<
      Pick<Transaction, "categoryId" | "payeeId" | "payeeName">
    > = {
      ...(changes.categoryId !== undefined
        ? { categoryId: changes.categoryId }
        : {}),
    };
    if (changes.payeeId !== undefined) {
      const payee =
        changes.payeeId === null
          ? null
          : await m.findOne(Payee, { where: { id: changes.payeeId, userId } });
      Object.assign(patch, {
        payeeId: changes.payeeId,
        payeeName: payee?.name ?? null,
      });
    }
    if (Object.keys(patch).length > 0) {
      await m.update(Transaction, { id: transactionId, userId }, patch);
    }
    if (changes.addTagIds.length > 0) {
      await this.tagsService.addTransactionTags(
        m,
        userId,
        [transactionId],
        changes.addTagIds,
      );
    }
    if (changes.removeTagIds.length > 0) {
      await this.tagsService.removeTransactionTags(
        m,
        userId,
        [transactionId],
        changes.removeTagIds,
      );
    }
    const traceRows = effects.trace
      .filter((entry) => Object.keys(entry.changes).length > 0)
      .map((entry) => ({
        userId,
        ruleId: entry.ruleId,
        transactionId,
        source,
        changes: { ...entry.changes },
      }));
    if (traceRows.length > 0) {
      await m.insert(TransactionRuleApplication, traceRows);
    }
  }
}
