import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import {
  Brackets,
  EntityManager,
  In,
  SelectQueryBuilder,
  DataSource,
} from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TagsService } from "../tags/tags.service";
import { TransactionSplitService } from "./transaction-split.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import {
  BulkUpdateDto,
  BulkDeleteDto,
  BulkUpdateFilterDto,
} from "./dto/bulk-update.dto";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import {
  isTransactionInFuture,
  formatDateYMDLocal,
} from "../common/date-utils";
import {
  buildTransactionSearchClause,
  escapeLikePattern,
} from "./transaction-search.util";
import {
  parseSearchTerm,
  ParsedSearchTerm,
} from "./transaction-search-parse.util";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { lockTransactionRows } from "../common/db/locks";

export interface BulkDeleteResult {
  deleted: number;
}

export interface BulkUpdateResult {
  updated: number;
  skipped: number;
  skippedReasons: string[];
  /**
   * Split lines recategorized across the batch's split parents. A sibling
   * count, never folded into `updated` (invariant I5,
   * docs/future-plans/split-bulk-update.md). Omitted when zero.
   */
  splitLinesUpdated?: number;
}

/** One changed split line, as returned by bulkRecategorizeCategorySplits. */
interface ChangedSplitLine {
  splitId: string;
  transactionId: string;
  previousCategoryId: string | null;
}

/** Per-transaction snapshot rows for the Action History bulk_update record. */
interface BulkUpdateSnapshot {
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}

/**
 * The columns the WP1b undo snapshot can capture, keyed by the updateFields
 * property they mirror. Keys come from extractUpdateFields' whitelist; the
 * values are literal column names, never request input.
 */
const SNAPSHOT_COLUMNS: Record<string, string> = {
  payeeId: "payee_id",
  payeeName: "payee_name",
  categoryId: "category_id",
  description: "description",
  status: "status",
};

@Injectable()
export class TransactionBulkUpdateService {
  private readonly logger = new Logger(TransactionBulkUpdateService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private tagsService: TagsService,
    private splitService: TransactionSplitService,
    private actionHistoryService: ActionHistoryService,
    private dataSource: DataSource,
  ) {}

  /**
   * Interprets the search term as an exact amount and/or date using the user's
   * number/date-format preferences, so locale-formatted values also match.
   */
  private async resolveSearchTerm(
    userId: string,
    term?: string,
  ): Promise<ParsedSearchTerm> {
    if (!term || !term.trim()) return { amount: null, date: null };
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    return parseSearchTerm(term, {
      numberFormat: prefs?.numberFormat,
      dateFormat: prefs?.dateFormat,
    });
  }

  async bulkUpdate(
    userId: string,
    dto: BulkUpdateDto,
  ): Promise<BulkUpdateResult> {
    const updateFields = this.extractUpdateFields(dto);
    const isUpdatingTags = "tagIds" in dto;
    if (Object.keys(updateFields).length === 0 && !isUpdatingTags) {
      throw new BadRequestException(
        tr(
          "errors.transactions.bulkUpdateNoFields",
          "At least one update field must be provided",
        ),
      );
    }

    // H4: Validate ownership of categoryId and payeeId before applying
    if ("categoryId" in dto && dto.categoryId) {
      const categoryId = dto.categoryId;
      const cat = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).findOne({
          where: { id: categoryId, userId },
        }),
      );
      if (!cat) {
        throw new NotFoundException(
          tr("errors.transactions.categoryNotFound", "Category not found"),
        );
      }
    }
    if ("payeeId" in dto && dto.payeeId) {
      const payeeId = dto.payeeId;
      const payee = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Payee).findOne({
          where: { id: payeeId, userId },
        }),
      );
      if (!payee) {
        throw new NotFoundException(
          tr("errors.transactions.payeeNotFound", "Payee not found"),
        );
      }
    }

    const isUpdatingCategory = "categoryId" in dto;
    const isUpdatingStatus = "status" in dto;

    // Step 1: Get eligible transaction IDs
    const allIds = await this.resolveTransactionIds(userId, dto);
    if (allIds.length === 0) {
      return { updated: 0, skipped: 0, skippedReasons: [] };
    }

    // Step 2: Classify targets. Split parents stay in the batch (parent-level
    // fields apply to them); when the run sets a category their lines are
    // recategorized instead of the parent (invariant I1).
    const { eligibleIds, splitParentIds } = await this.classifyTargets(
      userId,
      allIds,
    );

    if (eligibleIds.length === 0) {
      return { updated: 0, skipped: 0, skippedReasons: [] };
    }

    const splitParentIdSet = new Set(splitParentIds);
    let changedLines: ChangedSplitLine[] = [];
    let snapshot: BulkUpdateSnapshot = { before: [], after: [] };

    // Balance changes and the batch update commit in a single transaction.
    await withScopedDb(this.dataSource, async (m) => {
      // Lock every row this batch will write, ascending by id, before anything
      // reads the statuses the VOID adjustment is derived from. One transaction
      // was not enough: handleStatusBalanceChanges aggregates the *current*
      // statuses and the UPDATE that changes them runs afterwards, so without
      // the lock a concurrent single-transaction edit lands in between and the
      // batch applies a delta for a transition that no longer happened.
      if (isUpdatingStatus) {
        await lockTransactionRows(m, eligibleIds, userId);
      }

      // Step 3: Handle balance adjustments for VOID status changes
      if (isUpdatingStatus) {
        await this.handleStatusBalanceChanges(
          m,
          userId,
          eligibleIds,
          dto.status!,
        );
      }

      // WP1b: read the pre-write values of exactly the fields this run changes,
      // before any UPDATE runs. The split-line half of the snapshot comes from
      // bulkRecategorizeCategorySplits' own pre-read below.
      const parentSnapshot = await this.readParentSnapshot(
        m,
        userId,
        eligibleIds,
        updateFields,
        isUpdatingTags,
      );

      // Step 4: Execute batch update for column fields. When the run sets a
      // category, split parents must not receive it (their category_id stays
      // NULL -- invariant I1), so their UPDATE drops categoryId.
      if (Object.keys(updateFields).length > 0) {
        const fullFieldIds = isUpdatingCategory
          ? eligibleIds.filter((id) => !splitParentIdSet.has(id))
          : eligibleIds;
        if (fullFieldIds.length > 0) {
          await m
            .createQueryBuilder()
            .update(Transaction)
            .set(updateFields)
            .where("id IN (:...ids)", { ids: fullFieldIds })
            .andWhere("userId = :userId", { userId })
            .execute();
        }

        if (isUpdatingCategory && splitParentIds.length > 0) {
          const splitParentFields = { ...updateFields };
          delete (splitParentFields as Record<string, unknown>).categoryId;
          if (Object.keys(splitParentFields).length > 0) {
            await m
              .createQueryBuilder()
              .update(Transaction)
              .set(splitParentFields)
              .where("id IN (:...ids)", { ids: splitParentIds })
              .andWhere("userId = :userId", { userId })
              .execute();
          }
        }

        // Step 4b: Sync payee/description to linked transfer transactions
        await this.syncLinkedTransfers(m, userId, eligibleIds, updateFields);
      }

      // Step 4c: Update tags (many-to-many relation). Validates the tag set
      // once and replaces tags with a single bulk delete + insert across all
      // eligible transactions.
      if (isUpdatingTags) {
        await this.tagsService.setTransactionTagsBulk(
          eligibleIds,
          dto.tagIds ?? [],
          userId,
        );

        // Keep transfer counterparts in step, mirroring the single-edit flow
        // (updateTransfer wrapper): plain transfer legs share tags with their
        // mirror leg; split-transfer legs mirror tags onto the owning split.
        await this.syncTransferTags(m, userId, eligibleIds, dto.tagIds ?? []);
      }

      // Step 4d: Recategorize the split parents' category-kind lines, joined
      // to this transaction. The restriction set is computed with the same
      // expansion the selection uses, so update and selection cannot drift.
      if (isUpdatingCategory && splitParentIds.length > 0) {
        const restriction = await this.resolveCategoryRestriction(
          m,
          userId,
          dto,
        );
        changedLines = await this.splitService.bulkRecategorizeCategorySplits(
          userId,
          splitParentIds,
          dto.categoryId ?? null,
          restriction,
        );
      }

      snapshot = this.buildSnapshots(
        parentSnapshot,
        updateFields,
        isUpdatingCategory,
        splitParentIdSet,
        isUpdatingTags,
        dto.tagIds,
        changedLines,
        dto.categoryId ?? null,
      );
    });

    // Step 5: Trigger net worth recalc for affected accounts (after commit)
    if (isUpdatingStatus) {
      await this.triggerNetWorthRecalcForTransactions(userId, eligibleIds);
    }

    // Result (invariant I5): a parent counts as updated only when it received
    // at least one write. With a category-only run, a split parent none of
    // whose lines changed received nothing and is skipped with a reason.
    const parentLevelChangesApply =
      Object.keys(updateFields).some((k) => k !== "categoryId") ||
      isUpdatingTags;
    const changedParentIds = new Set(changedLines.map((l) => l.transactionId));
    const skippedSplitParents =
      isUpdatingCategory && !parentLevelChangesApply
        ? splitParentIds.filter((id) => !changedParentIds.has(id))
        : [];
    const updated = eligibleIds.length - skippedSplitParents.length;

    const skippedReasons: string[] = [];
    if (skippedSplitParents.length === 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkSplitNoMatchingLinesOne",
          "1 split transaction was skipped because none of its split lines matched the category update",
        ),
      );
    } else if (skippedSplitParents.length > 1) {
      skippedReasons.push(
        tr(
          "errors.transactions.bulkSplitNoMatchingLinesMany",
          `${skippedSplitParents.length} split transactions were skipped because none of their split lines matched the category update`,
          { count: skippedSplitParents.length },
        ),
      );
    }

    // WP1b: record the undo entry AFTER the transaction committed (record
    // swallows its own failures, which is only safe outside a transaction --
    // see derived-state-writers.guard.spec.ts). Skipped parents received no
    // write, so they are excluded from the snapshot.
    if (updated > 0) {
      const skippedSet = new Set(skippedSplitParents);
      const keep = (row: Record<string, unknown>) =>
        !skippedSet.has(row.id as string);
      void this.actionHistoryService.record(userId, {
        entityType: "bulk_transaction",
        entityId: null,
        action: "bulk_update",
        beforeData: { transactions: snapshot.before.filter(keep) },
        afterData: { transactions: snapshot.after.filter(keep) },
        description: `Bulk updated ${updated} transaction${updated === 1 ? "" : "s"}`,
        descriptionKey: "bulkUpdatedTransactions",
        descriptionParams: { count: updated },
      });
    }

    const result: BulkUpdateResult = {
      updated,
      skipped: skippedSplitParents.length,
      skippedReasons,
    };
    if (changedLines.length > 0) {
      result.splitLinesUpdated = changedLines.length;
    }
    return result;
  }

  async bulkDelete(
    userId: string,
    dto: BulkDeleteDto,
  ): Promise<BulkDeleteResult> {
    const allIds = await this.resolveTransactionIds(userId, dto);
    if (allIds.length === 0) {
      return { deleted: 0 };
    }

    // Load transaction details needed for balance adjustments and linked transfers
    const transactions = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select([
          "transaction.id",
          "transaction.accountId",
          "transaction.amount",
          "transaction.status",
          "transaction.transactionDate",
          "transaction.isTransfer",
          "transaction.linkedTransactionId",
          "transaction.isSplit",
        ])
        .leftJoinAndSelect("transaction.splits", "splits")
        .where("transaction.id IN (:...ids)", { ids: allIds })
        .andWhere("transaction.userId = :userId", { userId })
        .getMany(),
    );

    if (transactions.length === 0) {
      return { deleted: 0 };
    }

    // Balance adjustments and both delete passes commit atomically.
    let deleted = 0;
    await withScopedDb(this.dataSource, async (m) => {
      // Collect linked transaction IDs from transfers and split transfers
      const linkedIdsToDelete = new Set<string>();
      const transactionIdsSet = new Set(transactions.map((t) => t.id));

      for (const tx of transactions) {
        if (
          tx.linkedTransactionId &&
          !transactionIdsSet.has(tx.linkedTransactionId)
        ) {
          linkedIdsToDelete.add(tx.linkedTransactionId);
        }
        if (tx.isSplit && tx.splits) {
          for (const split of tx.splits) {
            if (
              split.linkedTransactionId &&
              !transactionIdsSet.has(split.linkedTransactionId)
            ) {
              linkedIdsToDelete.add(split.linkedTransactionId);
            }
          }
        }
      }

      // Lock every row about to be deleted -- primary and linked alike --
      // ascending by id, and derive the reversals from the locked values.
      //
      // The `transactions` read above happened before this transaction opened,
      // so its amounts and statuses are a claim about the past. A row another
      // request deleted in the meantime is simply absent from `locked`, and gets
      // no reversal: reversing an amount whose row is already gone is how a
      // double delete leaves the balance 10.00 above the ledger (P4-003).
      const locked = await lockTransactionRows(
        m,
        [...allIds, ...linkedIdsToDelete],
        userId,
      );

      const balanceAdjustments = new Map<string, number>();
      for (const tx of locked.values()) {
        if (
          tx.status !== TransactionStatus.VOID &&
          !isTransactionInFuture(tx.transactionDate)
        ) {
          const current = balanceAdjustments.get(tx.accountId) || 0;
          balanceAdjustments.set(tx.accountId, current - tx.amount);
        }
      }

      for (const accountId of [...balanceAdjustments.keys()].sort()) {
        const adjustment = balanceAdjustments.get(accountId)!;
        if (adjustment !== 0) {
          await this.accountsService.updateBalance(accountId, adjustment);
        }
      }

      // Delete linked transactions first (foreign key order)
      if (linkedIdsToDelete.size > 0) {
        await m
          .createQueryBuilder()
          .delete()
          .from(Transaction)
          .where("id IN (:...ids)", { ids: [...linkedIdsToDelete] })
          .andWhere("userId = :userId", { userId })
          .execute();
      }

      // Delete the primary transactions
      const primaryDeleted = await m
        .createQueryBuilder()
        .delete()
        .from(Transaction)
        .where("id IN (:...ids)", { ids: allIds })
        .andWhere("userId = :userId", { userId })
        .execute();
      // What the database removed, not what the pre-read hoped to remove: a row
      // a concurrent request already deleted must not be counted twice.
      deleted = primaryDeleted.affected ?? 0;
    });

    // Trigger net worth recalc for all affected accounts
    const affectedAccountIds = new Set(transactions.map((t) => t.accountId));
    for (const accountId of affectedAccountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }

    return { deleted };
  }

  private extractUpdateFields(dto: BulkUpdateDto): Partial<Transaction> {
    const fields: Record<string, unknown> = {};

    if ("payeeId" in dto) {
      fields.payeeId = dto.payeeId ?? null;
    }
    if ("payeeName" in dto) {
      fields.payeeName = dto.payeeName ?? null;
    }
    if ("categoryId" in dto) {
      fields.categoryId = dto.categoryId ?? null;
    }
    if ("description" in dto) {
      fields.description = dto.description ?? null;
    }
    if ("status" in dto) {
      fields.status = dto.status;
    }

    return fields as Partial<Transaction>;
  }

  private async resolveTransactionIds(
    userId: string,
    dto: BulkUpdateDto | BulkDeleteDto,
  ): Promise<string[]> {
    if (dto.mode === "ids") {
      if (!dto.transactionIds || dto.transactionIds.length === 0) {
        return [];
      }

      const transactions = await withScopedDb(this.dataSource, (m) =>
        m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .select("transaction.id")
          .where("transaction.id IN (:...ids)", { ids: dto.transactionIds })
          .andWhere("transaction.userId = :userId", { userId })
          .getMany(),
      );

      return transactions.map((t) => t.id);
    }

    // Filter mode
    const transactions = await withScopedDb(this.dataSource, async (m) => {
      const queryBuilder = m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select("transaction.id")
        .where("transaction.userId = :userId", { userId });

      await this.applyFilters(m, queryBuilder, userId, dto.filters || {});

      if (dto.excludedIds && dto.excludedIds.length > 0) {
        queryBuilder.andWhere("transaction.id NOT IN (:...excludedIds)", {
          excludedIds: dto.excludedIds,
        });
      }

      return queryBuilder.getMany();
    });
    return transactions.map((t) => t.id);
  }

  /**
   * Classify the batch: every owned row is eligible (split parents included),
   * and the split parents are named so a category update can route their
   * change to the split lines instead of the parent row.
   */
  private async classifyTargets(
    userId: string,
    allIds: string[],
  ): Promise<{
    eligibleIds: string[];
    splitParentIds: string[];
  }> {
    const transactions = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select([
          "transaction.id",
          "transaction.isTransfer",
          "transaction.isSplit",
        ])
        .where("transaction.id IN (:...ids)", { ids: allIds })
        .andWhere("transaction.userId = :userId", { userId })
        .getMany(),
    );

    return {
      eligibleIds: transactions.map((t) => t.id),
      splitParentIds: transactions.filter((t) => t.isSplit).map((t) => t.id),
    };
  }

  /**
   * The restriction set for split-line recategorization: filter mode with real
   * category UUIDs in the filter yields the descendant-expanded set (matching
   * the selection's own expansion); everything else -- ids mode, no category
   * filter, pseudo-ids only -- is unrestricted (`undefined` = all category
   * lines), per Truth table A in docs/future-plans/split-bulk-update.md.
   */
  private async resolveCategoryRestriction(
    m: EntityManager,
    userId: string,
    dto: BulkUpdateDto,
  ): Promise<string[] | undefined> {
    // The restriction keys off the category filter that was ACTIVE in the UI,
    // not off the selection mode: hand-picked rows arrive as mode "ids" and
    // must still honor the filter the user was looking through, so the client
    // sends it explicitly as categoryFilterIds in both modes. Filter-mode
    // filters.categoryIds remains a fallback for payloads without the field.
    const categoryIds =
      dto.categoryFilterIds ??
      (dto.mode === "filter" ? dto.filters?.categoryIds : undefined);
    if (!categoryIds || categoryIds.length === 0) return undefined;
    const expanded = await this.expandRealCategoryIds(m, userId, categoryIds);
    return expanded.length > 0 ? expanded : undefined;
  }

  /**
   * Pre-write values of exactly the fields this run changes, camel-cased to the
   * shape ActionHistoryService.undoBulkUpdate restores. Raw SQL on purpose: no
   * DATE/decimal columns are captured, and the column list comes from the
   * SNAPSHOT_COLUMNS whitelist, never from request input.
   */
  private async readParentSnapshot(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    updateFields: Partial<Transaction>,
    isUpdatingTags: boolean,
  ): Promise<{
    rows: Record<string, unknown>[];
    tagsByTransaction: Map<string, string[]>;
  }> {
    const fieldKeys = Object.keys(updateFields).filter(
      (k) => k in SNAPSHOT_COLUMNS,
    );
    const columns = [
      "id",
      "account_id",
      ...fieldKeys.map((k) => SNAPSHOT_COLUMNS[k]),
    ];
    const rawRows: Record<string, unknown>[] =
      (await m.query(
        `SELECT ${columns.join(", ")} FROM transactions WHERE user_id = $1 AND id = ANY($2)`,
        [userId, eligibleIds],
      )) ?? [];

    const rows = rawRows.map((raw) => {
      const row: Record<string, unknown> = {
        id: raw.id,
        accountId: raw.account_id,
      };
      for (const key of fieldKeys) {
        row[key] = raw[SNAPSHOT_COLUMNS[key]] ?? null;
      }
      return row;
    });

    const tagsByTransaction = new Map<string, string[]>();
    if (isUpdatingTags) {
      const tagRows: { transaction_id: string; tag_id: string }[] =
        (await m.query(
          `SELECT tt.transaction_id, tt.tag_id
             FROM transaction_tags tt
             JOIN transactions t ON t.id = tt.transaction_id
            WHERE t.user_id = $1 AND tt.transaction_id = ANY($2)`,
          [userId, eligibleIds],
        )) ?? [];
      for (const tagRow of tagRows) {
        const list = tagsByTransaction.get(tagRow.transaction_id) ?? [];
        tagsByTransaction.set(tagRow.transaction_id, [...list, tagRow.tag_id]);
      }
    }

    return { rows, tagsByTransaction };
  }

  /**
   * Assemble the before/after snapshots for the Action History record. Split
   * parents never carry `categoryId` in either side (undo/redo must not write a
   * parent category onto a split -- invariant I1); their changed lines ride
   * along as `splits: [{ id, categoryId }]`.
   */
  private buildSnapshots(
    parentSnapshot: {
      rows: Record<string, unknown>[];
      tagsByTransaction: Map<string, string[]>;
    },
    updateFields: Partial<Transaction>,
    isUpdatingCategory: boolean,
    splitParentIdSet: Set<string>,
    isUpdatingTags: boolean,
    newTagIds: string[] | undefined,
    changedLines: ChangedSplitLine[],
    newCategoryId: string | null,
  ): BulkUpdateSnapshot {
    const linesByParent = new Map<string, ChangedSplitLine[]>();
    for (const line of changedLines) {
      const list = linesByParent.get(line.transactionId) ?? [];
      linesByParent.set(line.transactionId, [...list, line]);
    }

    const before: Record<string, unknown>[] = [];
    const after: Record<string, unknown>[] = [];

    for (const row of parentSnapshot.rows) {
      const id = row.id as string;
      const isSplitParent = splitParentIdSet.has(id);

      const beforeRow: Record<string, unknown> = { ...row };
      const afterRow: Record<string, unknown> = {
        id,
        accountId: row.accountId,
        ...updateFields,
      };
      if (isUpdatingCategory && isSplitParent) {
        delete beforeRow.categoryId;
        delete afterRow.categoryId;
      }

      if (isUpdatingTags) {
        beforeRow.tagIds = parentSnapshot.tagsByTransaction.get(id) ?? [];
        afterRow.tagIds = newTagIds ?? [];
      }

      const lines = linesByParent.get(id);
      if (lines && lines.length > 0) {
        beforeRow.splits = lines.map((l) => ({
          id: l.splitId,
          categoryId: l.previousCategoryId,
        }));
        afterRow.splits = lines.map((l) => ({
          id: l.splitId,
          categoryId: newCategoryId,
        }));
      }

      before.push(beforeRow);
      after.push(afterRow);
    }

    return { before, after };
  }

  /**
   * For transfer transactions in the batch, apply payee and description
   * updates to their linked counterparts so both sides stay in sync.
   * Category is NOT synced because each side of a transfer may use
   * different categories (e.g. "Transfer In" vs "Transfer Out").
   */
  private async syncLinkedTransfers(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    updateFields: Partial<Transaction>,
  ): Promise<void> {
    // Build the subset of fields that should sync to the linked side
    const syncFields: Record<string, unknown> = {};
    if ("payeeId" in updateFields) syncFields.payeeId = updateFields.payeeId;
    if ("payeeName" in updateFields)
      syncFields.payeeName = updateFields.payeeName;
    if ("description" in updateFields)
      syncFields.description = updateFields.description;

    if (Object.keys(syncFields).length === 0) return;

    const { plainLinkedIds, owningSplitIds } = await this.classifyTransferLegs(
      m,
      userId,
      eligibleIds,
    );

    if (plainLinkedIds.length > 0) {
      await m
        .createQueryBuilder()
        .update(Transaction)
        .set(syncFields as Partial<Transaction>)
        .where("id IN (:...ids)", { ids: plainLinkedIds })
        .andWhere("userId = :userId", { userId })
        .execute();
    }

    // Split-transfer legs mirror the description onto the owning split's memo
    // instead (matching updateSplitTransferLeg); payee changes stay on the leg.
    if ("description" in syncFields && owningSplitIds.length > 0) {
      await m
        .createQueryBuilder()
        .update(TransactionSplit)
        .set({ memo: (syncFields.description as string | null) ?? null })
        .where("id IN (:...ids)", { ids: owningSplitIds })
        .execute();
    }
  }

  /**
   * Mirror a bulk tag change onto transfer counterparts, matching the
   * single-edit flow (the updateTransfer wrapper): plain transfer legs share
   * one tag set with their mirror leg; split-transfer legs mirror the tags
   * onto the owning split's split-level tags (never the split parent).
   */
  private async syncTransferTags(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    tagIds: string[],
  ): Promise<void> {
    const { plainLinkedIds, owningSplitIds } = await this.classifyTransferLegs(
      m,
      userId,
      eligibleIds,
    );

    // Mirror legs not already covered by the batch itself.
    const eligibleSet = new Set(eligibleIds);
    const linkedToUpdate = plainLinkedIds.filter((id) => !eligibleSet.has(id));
    if (linkedToUpdate.length > 0) {
      await this.tagsService.setTransactionTagsBulk(
        linkedToUpdate,
        tagIds,
        userId,
      );
    }

    if (owningSplitIds.length > 0) {
      await this.tagsService.setSplitTagsBulk(owningSplitIds, tagIds, userId);
    }
  }

  /**
   * Classify the transfer legs among a batch. A split-transfer leg is owned by
   * a transaction_splits row and its linkedTransactionId points at the split
   * PARENT (whose fields aggregate the whole split) -- syncing there would
   * clobber the parent. A plain transfer leg's linkedTransactionId is its
   * mirror leg, which is safe to sync.
   */
  private async classifyTransferLegs(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
  ): Promise<{ plainLinkedIds: string[]; owningSplitIds: string[] }> {
    const repo = m.getRepository(Transaction);
    const transfers = await repo
      .createQueryBuilder("t")
      .select(["t.id", "t.linkedTransactionId"])
      .where("t.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("t.userId = :userId", { userId })
      .andWhere("t.isTransfer = true")
      .andWhere("t.linkedTransactionId IS NOT NULL")
      .getMany();

    if (transfers.length === 0) {
      return { plainLinkedIds: [], owningSplitIds: [] };
    }

    const owningSplits = await m.find(TransactionSplit, {
      where: { linkedTransactionId: In(transfers.map((t) => t.id)) },
      select: ["id", "linkedTransactionId"],
    });
    const splitLegIds = new Set(owningSplits.map((s) => s.linkedTransactionId));

    const candidateLinkedIds = transfers
      .filter((t) => !splitLegIds.has(t.id))
      .map((t) => t.linkedTransactionId)
      .filter((id): id is string => id !== null);

    // A cross-owner counterpart belongs to another user; tag ids are per-user
    // reference data, so only same-user linked legs may be synced. (The
    // field sync in syncLinkedTransfers is additionally user-filtered in its
    // UPDATE, but the tag path hands these ids straight to the bulk tag
    // writer.)
    const plainLinkedIds =
      candidateLinkedIds.length === 0
        ? candidateLinkedIds
        : (
            await repo
              .createQueryBuilder("t")
              .select(["t.id"])
              .where("t.id IN (:...ids)", { ids: candidateLinkedIds })
              .andWhere("t.userId = :userId", { userId })
              .getMany()
          ).map((t) => t.id);

    return {
      plainLinkedIds,
      owningSplitIds: owningSplits.map((s) => s.id),
    };
  }

  private async handleStatusBalanceChanges(
    m: EntityManager,
    userId: string,
    eligibleIds: string[],
    newStatus: TransactionStatus,
  ): Promise<void> {
    const isNewVoid = newStatus === TransactionStatus.VOID;

    // Query transactions that will actually change to/from VOID
    const statusCondition = isNewVoid
      ? "transaction.status != :voidStatus"
      : "transaction.status = :voidStatus";

    // Only include non-future transactions in balance changes
    const today = formatDateYMDLocal(new Date());

    const balanceDeltas = await m
      .getRepository(Transaction)
      .createQueryBuilder("transaction")
      .select("transaction.accountId", "accountId")
      .addSelect("SUM(transaction.amount)", "totalAmount")
      .where("transaction.id IN (:...ids)", { ids: eligibleIds })
      .andWhere("transaction.userId = :userId", { userId })
      .andWhere(statusCondition, { voidStatus: TransactionStatus.VOID })
      .andWhere("transaction.transactionDate <= :today", { today })
      .groupBy("transaction.accountId")
      .getRawMany();

    for (const row of balanceDeltas) {
      const amount = Number(row.totalAmount) || 0;
      if (amount === 0) continue;

      if (isNewVoid) {
        // Becoming VOID: subtract amounts from balances
        await this.accountsService.updateBalance(row.accountId, -amount);
      } else {
        // Leaving VOID: add amounts to balances
        await this.accountsService.updateBalance(row.accountId, amount);
      }
    }
  }

  private async triggerNetWorthRecalcForTransactions(
    userId: string,
    transactionIds: string[],
  ): Promise<void> {
    const accountIds = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .select("DISTINCT transaction.accountId", "accountId")
        .where("transaction.id IN (:...ids)", { ids: transactionIds })
        .getRawMany(),
    );

    for (const row of accountIds) {
      this.netWorthService.triggerDebouncedRecalc(row.accountId, userId);
    }
  }

  private async applyFilters(
    m: EntityManager,
    queryBuilder: SelectQueryBuilder<Transaction>,
    userId: string,
    filters: BulkUpdateFilterDto,
  ): Promise<void> {
    if (filters.accountIds && filters.accountIds.length > 0) {
      queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
        accountIds: filters.accountIds,
      });
    }

    if (filters.startDate) {
      queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
        startDate: filters.startDate,
      });
    }

    if (filters.endDate) {
      queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
        endDate: filters.endDate,
      });
    }

    if (filters.categoryIds && filters.categoryIds.length > 0) {
      await this.applyCategoryFilters(
        m,
        queryBuilder,
        userId,
        filters.categoryIds,
      );
    }

    if (filters.payeeIds && filters.payeeIds.length > 0) {
      queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
        payeeIds: filters.payeeIds,
      });
    }

    if (filters.search && filters.search.trim()) {
      const searchPattern = `%${escapeLikePattern(filters.search.trim())}%`;
      const parsedSearch = await this.resolveSearchTerm(userId, filters.search);
      if (!filters.categoryIds || filters.categoryIds.length === 0) {
        queryBuilder.leftJoin("transaction.splits", "searchSplits");
        queryBuilder.andWhere(
          buildTransactionSearchClause({
            transaction: "transaction",
            splits: "searchSplits",
          }),
          {
            search: searchPattern,
            searchAmount: parsedSearch.amount,
            searchDate: parsedSearch.date,
          },
        );
      } else {
        queryBuilder.andWhere(
          buildTransactionSearchClause({
            transaction: "transaction",
            splits: "filterSplits",
          }),
          {
            search: searchPattern,
            searchAmount: parsedSearch.amount,
            searchDate: parsedSearch.date,
          },
        );
      }
    }

    if (filters.amountFrom !== undefined) {
      queryBuilder.andWhere("transaction.amount >= :amountFrom", {
        amountFrom: filters.amountFrom,
      });
    }

    if (filters.amountTo !== undefined) {
      queryBuilder.andWhere("transaction.amount <= :amountTo", {
        amountTo: filters.amountTo,
      });
    }

    if (filters.tagIds && filters.tagIds.length > 0) {
      // Split-aware, mirroring findAll: a tag on the parent or on any split
      // line matches. A dedicated splits alias avoids depending on the joins
      // the category/search branches may or may not have added.
      queryBuilder.leftJoin("transaction.tags", "filterTags");
      queryBuilder.leftJoin("transaction.splits", "tagSplits");
      queryBuilder.leftJoin("tagSplits.tags", "filterSplitTags");
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where("filterTags.id IN (:...filterTagIds)", {
            filterTagIds: filters.tagIds,
          }).orWhere("filterSplitTags.id IN (:...filterTagIds)", {
            filterTagIds: filters.tagIds,
          });
        }),
      );
    }
  }

  /**
   * The real (non-pseudo) category ids of a filter, descendant-expanded.
   * Written once so the selection predicate (applyCategoryFilters) and the
   * split-line recategorization restriction (resolveCategoryRestriction)
   * cannot drift apart. Returns [] when the filter holds only pseudo-ids.
   */
  private async expandRealCategoryIds(
    m: EntityManager,
    userId: string,
    categoryIds: string[],
  ): Promise<string[]> {
    const regularCategoryIds = categoryIds.filter(
      (id) => id !== "uncategorized" && id !== "transfer",
    );
    if (regularCategoryIds.length === 0) return [];
    return getAllCategoryIdsWithChildren(
      m.getRepository(Category),
      userId,
      regularCategoryIds,
    );
  }

  private async applyCategoryFilters(
    m: EntityManager,
    queryBuilder: SelectQueryBuilder<Transaction>,
    userId: string,
    categoryIds: string[],
  ): Promise<void> {
    const hasUncategorized = categoryIds.includes("uncategorized");
    const hasTransfer = categoryIds.includes("transfer");

    let hasCondition = false;

    // Expansion always contains its seed ids, so a non-empty real-id filter
    // yields a non-empty expansion and the outer condition is unchanged.
    const uniqueCategoryIds = await this.expandRealCategoryIds(
      m,
      userId,
      categoryIds,
    );

    if (hasUncategorized || hasTransfer || uniqueCategoryIds.length > 0) {
      if (hasUncategorized) {
        queryBuilder.leftJoin("transaction.account", "filterAccount");
      }

      if (uniqueCategoryIds.length > 0) {
        queryBuilder.leftJoin("transaction.splits", "filterSplits");
      }

      queryBuilder.andWhere(
        new Brackets((qb) => {
          if (hasUncategorized) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
              "transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND filterAccount.accountType != 'INVESTMENT'",
            );
          }
          if (hasTransfer) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method]("transaction.isTransfer = true");
          }
          if (uniqueCategoryIds.length > 0) {
            const method = hasCondition ? "orWhere" : "where";
            hasCondition = true;
            qb[method](
              new Brackets((inner) => {
                inner
                  .where("transaction.categoryId IN (:...filterCategoryIds)", {
                    filterCategoryIds: uniqueCategoryIds,
                  })
                  .orWhere(
                    "filterSplits.categoryId IN (:...filterCategoryIds)",
                    { filterCategoryIds: uniqueCategoryIds },
                  );
              }),
            );
          }
        }),
      );
    }
  }
}
