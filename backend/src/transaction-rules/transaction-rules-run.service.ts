import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  ActionHistoryService,
  MAX_JSONB_SIZE_BYTES,
} from "../action-history/action-history.service";
import { RULE_RUN_ENTITY_TYPE } from "../action-history/rule-run-undo";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { isReconciledLockEnabled } from "../transactions/reconciled-lock.util";
import { PreviewDraftRuleDto, RunTransactionRuleDto } from "./dto/rule-run.dto";
import { withActionDefaults } from "./rule-references";
import { PlannableRule } from "./rule-effects";
import { effectiveRunLimit, loadCandidateUnits } from "./rule-run-candidates";
import { loadRuleApplications } from "./rule-run-applications";
import { planFingerprint } from "./rule-run-fingerprint";
import { PlannedUnit, buildRunSnapshots } from "./rule-run-snapshot";
import {
  RuleApplicationRow,
  RuleRunChanges,
  RuleRunFilters,
  RuleRunMatchedRow,
  RuleRunPreview,
  RuleRunResult,
  RuleRunSkippedRow,
  RuleRunSkipReason,
} from "./rule-run.types";
import { RuleDefinition } from "./rule-validation";
import { TransactionRule } from "./transaction-rule.entity";
import { toRuleResponses } from "./transaction-rule-view";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesService } from "./transaction-rules.service";
import {
  DEFAULT_RULE_APPLICATIONS_LIMIT,
  MAX_RULE_APPLICATIONS_LIMIT,
} from "./transaction-rules.limits";

/** The rule as the planner reads it, plus what the run needs to name it. */
type RunRule = PlannableRule & { name: string; revision: number };

interface Plan {
  readonly preview: RuleRunPreview;
  readonly writable: readonly PlannedUnit[];
  readonly tagsByRow: ReadonlyMap<string, readonly string[]>;
}

/** The planner's refusals that a person can act on, in the words of the preview. */
const REFUSAL_REASONS: Readonly<Record<string, RuleRunSkipReason>> = {
  row_is_transfer_leg: "transfer_leg_category",
  row_has_splits: "split_category",
  cross_owner_transfer_leg: "cross_owner_transfer_payee",
};

/**
 * Run a rule on existing transactions (design 3.6, invariants I3 and I6).
 *
 * One planning path serves the preview, the test of an unsaved draft and the
 * commit: `plan` builds the facts in batches and calls the applier's
 * `planWithChains`, the function `create` uses. The commit re-plans inside its
 * own transaction and refuses, before any write, when the plan no longer
 * hashes to the fingerprint the preview returned.
 */
@Injectable()
export class TransactionRulesRunService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rulesService: TransactionRulesService,
    private readonly applier: TransactionRulesApplierService,
    private readonly actionHistory: ActionHistoryService,
  ) {}

  /** What running a saved rule on existing transactions would change. Writes nothing. */
  async previewRun(
    userId: string,
    ruleId: string,
    filters: RuleRunFilters,
  ): Promise<RuleRunPreview> {
    this.assertRange(filters);
    return withScopedDb(this.dataSource, async (m) => {
      const rule = await this.usableRule(m, userId, ruleId, false);
      return (await this.plan(m, userId, rule, filters, false)).preview;
    });
  }

  /** The same for an unsaved draft, validated exactly like a create. Writes nothing. */
  async previewDraft(
    userId: string,
    dto: PreviewDraftRuleDto,
  ): Promise<RuleRunPreview> {
    const filters = dto.filters ?? {};
    this.assertRange(filters);
    return withScopedDb(this.dataSource, async (m) => {
      const definition: RuleDefinition =
        await this.rulesService.checkedDefinition(
          m,
          userId,
          dto.condition,
          dto.actions,
        );
      const draft: RunRule = {
        id: "draft",
        name: "draft",
        enabled: true,
        stopProcessing: false,
        revision: 0,
        condition: definition.condition,
        actions: withActionDefaults(definition.actions) as RunRule["actions"],
      };
      return (await this.plan(m, userId, draft, filters, false)).preview;
    });
  }

  /**
   * Commit a run. Inside ONE `withScopedDb`: the rule is share-locked, the
   * candidate rows are row-locked and read again, the plan is rebuilt, and a
   * fingerprint that differs from the preview's refuses with 409
   * PREVIEW_CHANGED before anything is written. Reconciled rows under the
   * strict lock are skipped and reported (I6). The undo entry is recorded once
   * the transaction has committed.
   */
  async run(
    userId: string,
    ruleId: string,
    dto: RunTransactionRuleDto,
  ): Promise<RuleRunResult> {
    this.assertRange(dto);
    const done = await withScopedDb(this.dataSource, async (m) => {
      const rule = await this.usableRule(m, userId, ruleId, true);
      const plan = await this.plan(m, userId, rule, dto, true);
      if (plan.preview.fingerprint !== dto.fingerprint) {
        throw new ConflictException({
          message: tr(
            "errors.transactionRules.previewChanged",
            "The transactions or the rule changed since the preview. Review the new preview and run again",
          ),
          errorCode: "PREVIEW_CHANGED",
          fingerprint: plan.preview.fingerprint,
        });
      }
      const { before, after } = buildRunSnapshots(
        plan.writable,
        plan.tagsByRow,
        plan.preview.labels.payees,
      );
      // The undo entry must hold every row this run touches; refuse a run it
      // could not hold, before the first write.
      if (JSON.stringify({ before, after }).length > MAX_JSONB_SIZE_BYTES) {
        throw new BadRequestException({
          message: tr(
            "errors.transactionRules.runTooLarge",
            "This run changes too many transactions to be undone in one step. Narrow the accounts or the dates and try again",
          ),
          errorCode: "RUN_TOO_LARGE",
        });
      }
      for (const { unit, effects } of plan.writable) {
        for (const leg of unit.legs) {
          await this.applier.writeEffects(m, userId, leg.id, effects, "manual");
        }
      }
      return { rule, plan, before, after };
    });

    const changed = done.before.length;
    // After the commit: a history write inside the transaction would hide an
    // abort behind its own swallow (derived-state-writers.guard.spec.ts).
    const entry =
      changed > 0
        ? await this.actionHistory.record(userId, {
            entityType: RULE_RUN_ENTITY_TYPE,
            entityId: done.rule.id,
            action: "bulk_update",
            beforeData: { ruleId: done.rule.id, transactions: done.before },
            afterData: { ruleId: done.rule.id, transactions: done.after },
            description: `Ran rule "${done.rule.name}" on ${changed} transaction${changed === 1 ? "" : "s"}`,
            descriptionKey: "ranTransactionRule",
            descriptionParams: { name: done.rule.name, count: changed },
          })
        : null;
    return {
      changed,
      skipped: done.plan.preview.skipped,
      historyId: entry?.id ?? null,
    };
  }

  /** The latest applications of a rule, newest first, for the trace view. */
  async applications(
    userId: string,
    ruleId: string,
    limit: number = DEFAULT_RULE_APPLICATIONS_LIMIT,
  ): Promise<RuleApplicationRow[]> {
    const take = Math.min(
      Math.max(Math.trunc(limit), 1),
      MAX_RULE_APPLICATIONS_LIMIT,
    );
    return withScopedDb(this.dataSource, async (m) => {
      await this.rulesService.getOwnedRule(m, userId, ruleId);
      return loadRuleApplications(m, userId, ruleId, take);
    });
  }

  /** A saved rule the run can evaluate; a rule that no longer validates is refused. */
  private async usableRule(
    m: EntityManager,
    userId: string,
    ruleId: string,
    share: boolean,
  ): Promise<RunRule> {
    const rule: TransactionRule = await this.rulesService.getOwnedRule(
      m,
      userId,
      ruleId,
      { share },
    );
    const [view] = await toRuleResponses(m, userId, [rule]);
    if (view.invalid) {
      throw new BadRequestException({
        message: tr(
          "errors.transactionRules.ruleInvalid",
          "This rule is not valid, so it cannot be run. Open it and repair it first",
        ),
        errorCode: "INVALID_RULE",
        errors: view.invalidReasons,
      });
    }
    // A manual run is the user's explicit choice: a disabled rule runs too.
    return {
      id: rule.id,
      name: rule.name,
      enabled: true,
      stopProcessing: rule.stopProcessing,
      revision: rule.revision,
      condition: rule.condition,
      actions: rule.actions,
    };
  }

  private assertRange(filters: RuleRunFilters): void {
    if (
      filters.startDate &&
      filters.endDate &&
      filters.startDate > filters.endDate
    ) {
      throw new BadRequestException({
        message: tr(
          "errors.transactionRules.dateRangeInvalid",
          "The start date must not be after the end date",
        ),
        errorCode: "DATE_RANGE_INVALID",
      });
    }
  }

  /**
   * The one planning path. Facts are built from batch reads (candidates,
   * partners, tags, category chains) and evaluated by the applier's
   * `planWithChains`; nothing is written.
   */
  private async plan(
    m: EntityManager,
    userId: string,
    rule: RunRule,
    filters: RuleRunFilters,
    lock: boolean,
  ): Promise<Plan> {
    const { units, truncated } = await loadCandidateUnits(
      m,
      userId,
      { ...filters, limit: effectiveRunLimit(filters.limit) },
      { lock },
    );
    const legIds = units.flatMap((unit) => unit.legs.map((leg) => leg.id));
    const tagsByRow =
      legIds.length > 0
        ? await this.applier.loadTagIds(m, legIds)
        : new Map<string, string[]>();
    const chains = await this.applier.chainsFor(
      m,
      userId,
      [rule],
      units.map((unit) => unit.primary.categoryId),
    );

    const skipped: RuleRunSkippedRow[] = [];
    const changing: PlannedUnit[] = [];
    for (const unit of units) {
      const { primary } = unit;
      const effects = this.applier.planWithChains(
        {
          accountId: primary.accountId,
          currencyCode: primary.currencyCode,
          amount: primary.amount,
          isTransfer: unit.isTransfer,
          fromAccountId: unit.fromAccountId,
          toAccountId: unit.toAccountId,
          payeeId: primary.payeeId,
          payeeText: primary.payeeName,
          categoryId: primary.categoryId,
          description: primary.description,
          tagIds: tagsByRow.get(primary.id) ?? [],
          hasSplits: primary.isSplit,
        },
        [rule],
        chains,
        { crossOwnerTransferLeg: unit.crossOwnerTransferLeg },
      );
      const entry = effects.trace[0];
      for (const refused of entry?.skipped ?? []) {
        const reason = REFUSAL_REASONS[refused.reason];
        if (reason) skipped.push({ transactionId: primary.id, reason });
      }
      if (entry && Object.keys(entry.changes).length > 0) {
        changing.push({ unit, effects });
      }
    }

    // I6: a reconciled row is not altered while the strict lock is on.
    const hasReconciled = changing.some(({ unit }) =>
      unit.legs.some((leg) => leg.status === TransactionStatus.RECONCILED),
    );
    const strict = hasReconciled
      ? await isReconciledLockEnabled(m, userId)
      : false;
    const writable: PlannedUnit[] = [];
    for (const planned of changing) {
      const locked =
        strict &&
        planned.unit.legs.some(
          (leg) => leg.status === TransactionStatus.RECONCILED,
        );
      if (locked) {
        skipped.push({
          transactionId: planned.unit.primary.id,
          reason: "reconciled_locked",
        });
      } else {
        writable.push(planned);
      }
    }

    const matched: RuleRunMatchedRow[] = writable.map(({ unit, effects }) => ({
      transactionId: unit.primary.id,
      date: unit.primary.transactionDate,
      payeeName: unit.primary.payeeName,
      amount: Number(unit.primary.amount),
      currencyCode: unit.primary.currencyCode,
      changes: effects.trace[0].changes as RuleRunChanges,
    }));
    const labels = await this.applier.labelsFor(
      m,
      userId,
      {
        changes: { addTagIds: [], removeTagIds: [] },
        trace: writable.flatMap(({ effects }) => effects.trace),
        aiReviewRequests: [],
      },
      [rule],
    );
    return {
      preview: {
        matched,
        skipped,
        scanned: units.length,
        truncated,
        fingerprint: planFingerprint(
          rule.revision,
          writable.map(({ unit, effects }) => ({
            transactionId: unit.primary.id,
            changes: effects.trace[0].changes,
          })),
        ),
        labels,
      },
      writable,
      tagsByRow,
    };
  }
}
