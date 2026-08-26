import { Injectable } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import {
  ScheduledEffectiveAmountService,
  overrideEffectiveKey,
} from "./scheduled-effective-amount.service";
import {
  OccurrenceWindow,
  expandOccurrenceSlots,
} from "../common/scheduled-occurrences";
import { withScopedDb } from "../common/db/scoped-db";

/**
 * One occurrence of one schedule, priced at what it would post *today*.
 *
 * This is the server-authoritative occurrence contract issue #1247 asks for. The
 * effective-amount service answers "what does this schedule cost"; this answers
 * "what does THIS occurrence cost, and when does it fall" -- the question every
 * bills, budget, report, export, AI and MCP surface actually asks. Centralizing
 * the arithmetic was not enough on its own: each consumer still had to know that
 * the occurrence's identity is `originalDate`, that `overrideDate` moves it, and
 * which member of the resolver's result to read -- and they did not agree.
 *
 * `amount` is `null` exactly when the occurrence's current amount is unknown, and
 * `null` is never a licence to fall back to `ScheduledTransaction.amount`: that
 * scalar is a snapshot taken at whatever FX rate was current when it was written.
 * A consumer renders the occurrence as unavailable and withholds any total
 * containing it.
 */
export interface EffectiveScheduledOccurrence {
  scheduledTransactionId: string;
  /** The recurrence slot this occurrence came from -- its identity. */
  originalDate: string;
  /** The date it actually falls on: the override's date when one moved it. */
  dueDate: string;
  /** What this occurrence would post today, or `null` when that is unknown. */
  amount: number | null;
  /** The currency `amount` is expressed in (the settlement currency for an investment). */
  currencyCode: string;
  /** `amount !== null`. A total containing an incomplete occurrence is incomplete. */
  complete: boolean;
  /** The override governing this occurrence, or `null` when it runs on the base template. */
  overrideId: string | null;
  /** True when an override moved this occurrence off its recurrence slot. */
  moved: boolean;
  /**
   * The account whose balance this occurrence's cash moves through -- the
   * settlement account for an investment schedule, not the brokerage.
   */
  settlementAccountId: string;
  /** The settlement pair behind an unresolvable amount, when there is one to name. */
  settlementPair: { from: string; to: string } | null;
}

/**
 * Narrowing on *schedule* attributes, for a surface that genuinely wants fewer
 * rows. Deliberately not a general `where`: anything that decides which
 * occurrence applies belongs to this service, not to its callers.
 */
export interface OccurrenceCandidateFilter {
  /** Only schedules whose stored amount is negative. */
  outflowsOnly?: boolean;
  /** Only schedules the user has to post themselves. */
  manualOnly?: boolean;
}

/** An occurrence plus the row it came from, for a server-side consumer. */
export interface ResolvedScheduledOccurrence extends EffectiveScheduledOccurrence {
  schedule: ScheduledTransaction;
}

/**
 * The one place a scheduled occurrence is selected and priced (issue #1247,
 * INV-OCCURRENCE-003).
 *
 * Deliberately separate from `ScheduledTransactionsService`: budgets, the account
 * balance forecast and the AI/MCP payload all need occurrences without the
 * 4000-line write path, and a service that only reads keeps the dependency
 * one-directional.
 */
@Injectable()
export class ScheduledOccurrenceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly effectiveAmounts: ScheduledEffectiveAmountService,
  ) {}

  /**
   * The occurrences of `rows` that fall inside `window`, in due-date order.
   *
   * The caller supplies the rows (each surface filters differently -- outflows
   * only, manual-post only, one account) but **not** the overrides: this method
   * loads them itself, because "which override governs this occurrence" is
   * exactly the decision that was being made differently in each consumer. Rows
   * must carry their `splits` relation, which is what tells an FX-sensitive cash
   * total from a fixed one.
   *
   * Runs the resolver outside any read transaction of its own: the rate path can
   * fetch from a provider and persist.
   */
  async expand(
    userId: string,
    rows: ScheduledTransaction[],
    window: OccurrenceWindow,
  ): Promise<ResolvedScheduledOccurrence[]> {
    if (rows.length === 0) return [];

    const overridesBySchedule = await this.loadOverrides(rows.map((r) => r.id));

    // Hydrating `futureOverrides` is what makes the resolver price every override
    // this expansion might select. An override it did not price would read as "no
    // entry", and the substitution that follows -- the base amount standing in for
    // an occurrence the user changed -- is the defect issue #1247 is about.
    const hydrated = rows.map((row) => ({
      ...row,
      futureOverrides: overridesBySchedule.get(row.id) ?? [],
    }));
    const effective = await this.effectiveAmounts.resolveMany(userId, hydrated);

    const occurrences: ResolvedScheduledOccurrence[] = [];
    for (const row of rows) {
      // `resolveMany` answers for every row it was given, so this is total.
      const resolved = effective.get(row.id)!;
      const overrides = overridesBySchedule.get(row.id) ?? [];
      for (const slot of expandOccurrenceSlots(row, overrides, window)) {
        // Branch on the ENTRY, never on its amount: an override priced as unknown
        // reads as `null`, which `??` cannot tell from "no entry at all" -- and
        // falling through to the base amount is the substitution this contract
        // forbids.
        const own = slot.override
          ? resolved.overrides.get(overrideEffectiveKey(slot.override))
          : undefined;
        const amount = own ? own.effective : resolved.base;
        occurrences.push({
          scheduledTransactionId: row.id,
          originalDate: slot.originalDate,
          dueDate: slot.dueDate,
          amount: amount.amount,
          currencyCode: amount.currencyCode,
          complete: amount.complete,
          overrideId: slot.override?.id ?? null,
          moved: slot.moved,
          settlementAccountId: resolved.settlementAccountId,
          settlementPair: resolved.settlementPair,
          schedule: row,
        });
      }
    }

    return occurrences.sort((a, b) =>
      a.dueDate === b.dueDate
        ? a.scheduledTransactionId.localeCompare(b.scheduledTransactionId)
        : a.dueDate.localeCompare(b.dueDate),
    );
  }

  /**
   * Every active schedule's occurrences inside `window`, in due-date order.
   *
   * The candidate query asks the occurrence-aware question rather than the
   * schedule-shaped one: a schedule whose next recurrence slot sits beyond the
   * window still has an occurrence inside it when an override moved one back, so
   * `next_due_date <= through` alone loses it.
   *
   * `filter` narrows on stable *schedule* attributes only -- never on anything
   * that decides which occurrence applies. A surface that wants fewer rows says
   * so here rather than writing its own candidate query, which is how the
   * override rules got copied in the first place.
   */
  async findOccurrences(
    userId: string,
    window: OccurrenceWindow,
    filter: OccurrenceCandidateFilter = {},
  ): Promise<ResolvedScheduledOccurrence[]> {
    const rows = await withScopedDb(this.dataSource, (m) => {
      const qb = m
        .getRepository(ScheduledTransaction)
        .createQueryBuilder("st")
        .leftJoinAndSelect("st.account", "account")
        .leftJoinAndSelect("st.payee", "payee")
        .leftJoinAndSelect("st.category", "category")
        .leftJoinAndSelect("st.transferAccount", "transferAccount")
        .leftJoinAndSelect("st.investmentSecurity", "investmentSecurity")
        .leftJoinAndSelect(
          "st.investmentFundingAccount",
          "investmentFundingAccount",
        )
        // The splits decide whether a schedule's cash total re-prices at the
        // current rate, which the effective-amount resolver cannot answer
        // without them.
        .leftJoinAndSelect("st.splits", "splits")
        .where("st.userId = :userId", { userId })
        .andWhere("st.isActive = :isActive", { isActive: true })
        .andWhere(
          `(st.nextDueDate <= :through OR EXISTS (
              SELECT 1 FROM scheduled_transaction_overrides o
              WHERE o.scheduled_transaction_id = st.id
                AND o.override_date <= :through
            ))`,
          { through: window.through },
        )
        .orderBy("st.nextDueDate", "ASC");

      // The stored sign selects the outflows: an exchange rate is positive, so it
      // cannot flip one, and only the magnitude needs re-resolving.
      if (filter.outflowsOnly) qb.andWhere("st.amount < 0");
      // An auto-posted schedule needs no reminder -- the posting is the reminder.
      if (filter.manualOnly) {
        qb.andWhere("st.autoPost = :autoPost", { autoPost: false });
      }
      return qb.getMany();
    });

    return this.expand(userId, rows, window);
  }

  private async loadOverrides(
    scheduleIds: string[],
  ): Promise<Map<string, ScheduledTransactionOverride[]>> {
    const overrides = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).find({
        where: { scheduledTransactionId: In(scheduleIds) },
      }),
    );
    const bySchedule = new Map<string, ScheduledTransactionOverride[]>();
    for (const override of overrides) {
      const list = bySchedule.get(override.scheduledTransactionId) ?? [];
      list.push(override);
      bySchedule.set(override.scheduledTransactionId, list);
    }
    return bySchedule;
  }
}
