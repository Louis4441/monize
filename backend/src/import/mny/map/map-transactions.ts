import { randomUUID } from "node:crypto";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { roundMoney } from "../../../common/round.util";
import { MnyBill, MnyTransaction } from "../model/mny-rows";
import {
  MappedSplit,
  MappedTransaction,
  MappedTransactions,
} from "../model/mny-import-model";
import { isRecurrenceTemplate, mapTransactionStatus } from "../model/mny-model";
import { MnyWarning, MnyWarningRow } from "../model/mny-warnings";
import { MnyTransactionData } from "../tables/read-transactions";
import { TransferIndex, indexTransfers } from "./map-transfers";

/**
 * `TRN`, `TRN_SPLIT` and `TRN_XFER` mapped onto Monize transactions.
 *
 * The two rules that carry the most history:
 *
 * **The phantom filter is `frq != -1` and nothing else.** PR #192 also excluded
 * rows it read as auto-entered, but Money's scheduler posts real transactions --
 * including every loan payment -- so that filter is what made loan and mortgage
 * accounts import with zero transactions. Its sibling mistake outlived it:
 * `grftt & 0x80` was read as "voided" when it actually marks a row in a debt
 * account, so the loan payments that survived the filter all imported VOID and
 * dropped straight back out of the balance (see `MNY_TRANSACTION_FLAG`).
 *
 * **A split leg that is really a transfer stays a transfer.** PR #192 imported
 * every `TRN_SPLIT` child as a category-only row, so the principal leg of a loan
 * payment lost its transfer nature and showed blank. Here a child that appears
 * in `TRN_XFER` becomes a Monize transfer split pointing at the counterpart
 * transaction, which is imported exactly once as an ordinary row in the loan
 * account and links back to the *parent* payment -- the same wiring
 * `TransactionSplitService` produces for a hand-entered transfer split.
 */

export interface MapTransactionsInput {
  readonly transactions: MnyTransactionData;
  /** Money `hacct` -> account key, from `mapAccounts`. Absent = not imported. */
  readonly accountKeyByHandle: ReadonlyMap<number, string>;
  /** Money `hacct` -> the Monize account's currency. */
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** `BILL` rows, so their template transactions are not imported as postings. */
  readonly bills: readonly MnyBill[];
}

/** Everything the per-row mapping needs, computed once. */
interface Context {
  readonly input: MapTransactionsInput;
  readonly byHandle: ReadonlyMap<number, MnyTransaction>;
  /** `TRN_SPLIT.htrn` -- rows that are legs of another transaction. */
  readonly parentOfChild: ReadonlyMap<number, number>;
  readonly childrenByParent: ReadonlyMap<number, MnyTransaction[]>;
  readonly billTemplates: ReadonlySet<number>;
  readonly transfers: TransferIndex;
  /** Pre-generated ids for the rows that will be imported as transactions. */
  readonly idByHandle: ReadonlyMap<number, string>;
  readonly warnings: MnyWarning[];
}

/**
 * The flagged-row context a warning carries, so the review step can show the
 * user which transactions to look at in Money rather than a bare `htrn`.
 */
function warningRow(
  row: MnyTransaction,
  input: MapTransactionsInput,
): MnyWarningRow {
  return {
    handle: row.handle as number,
    accountKey:
      row.account === null
        ? null
        : (input.accountKeyByHandle.get(row.account) ?? null),
    date: row.date,
    amount: row.amount,
    payeeHandle: row.payee,
    reference: row.reference,
    memo: row.memo,
  };
}

/** `BILL.lHtrn` rows are recurrence templates, never postings. */
function billTemplateHandles(bills: readonly MnyBill[]): ReadonlySet<number> {
  return new Set(
    bills
      .map((bill) => bill.templateTransaction)
      .filter((handle): handle is number => handle !== null),
  );
}

interface Indexes {
  readonly byHandle: ReadonlyMap<number, MnyTransaction>;
  readonly parentOfChild: ReadonlyMap<number, number>;
  readonly childrenByParent: ReadonlyMap<number, MnyTransaction[]>;
  readonly billTemplates: ReadonlySet<number>;
  readonly transfers: TransferIndex;
  readonly warnings: MnyWarning[];
}

function buildIndexes(input: MapTransactionsInput): Indexes {
  const warnings: MnyWarning[] = [];
  const rows = input.transactions.transactions;

  const byHandle = new Map(
    rows
      .filter((row) => row.handle !== null)
      .map((row) => [row.handle as number, row]),
  );

  const parentOfChild = new Map<number, number>();
  const childrenByParent = new Map<number, MnyTransaction[]>();

  // Ordered by `iSplit` so legs keep the order the user sees in Money.
  for (const split of [...input.transactions.splits].sort(
    (a, b) => a.position - b.position,
  )) {
    if (split.parent === null || split.child === null) {
      continue;
    }
    const child = byHandle.get(split.child);
    if (!child) {
      continue;
    }
    parentOfChild.set(split.child, split.parent);
    if (!byHandle.has(split.parent)) {
      warnings.push({
        code: "orphanedSplit",
        subject: `htrn=${split.child}`,
        detail: `parent htrn=${split.parent}`,
        row: warningRow(child, input),
      });
      continue;
    }
    childrenByParent.set(split.parent, [
      ...(childrenByParent.get(split.parent) ?? []),
      child,
    ]);
  }

  return {
    byHandle,
    parentOfChild,
    childrenByParent,
    billTemplates: billTemplateHandles(input.bills),
    transfers: indexTransfers(input.transactions.transfers, rows),
    warnings,
  };
}

/**
 * Whether a row is a real posting worth importing as a banking transaction.
 *
 * Split children, bill templates, recurrence templates (`frq != -1`) and
 * genuinely orphaned transfer sides are out. Scheduler-posted rows are **in**:
 * they are real postings, and excluding them emptied PR #192's loan accounts.
 */
function isImportablePosting(
  row: MnyTransaction,
  indexes: Indexes,
  input: MapTransactionsInput,
): boolean {
  const handle = row.handle;
  return (
    handle !== null &&
    !indexes.parentOfChild.has(handle) &&
    !indexes.billTemplates.has(handle) &&
    !indexes.transfers.orphanedHandles.has(handle) &&
    !isRecurrenceTemplate(row.frequency) &&
    row.security === null &&
    row.date !== null &&
    row.account !== null &&
    input.accountKeyByHandle.has(row.account)
  );
}

/** The Monize account a row's transaction belongs in, or null when not imported. */
function accountKeyOf(
  row: MnyTransaction | null,
  input: MapTransactionsInput,
): string | null {
  return row?.account === null || row?.account === undefined
    ? null
    : (input.accountKeyByHandle.get(row.account) ?? null);
}

/**
 * The transaction id a transfer counterpart should point at.
 *
 * When the counterpart is itself a split leg, the link goes to that leg's
 * **parent** transaction -- Monize records the split's own leg on
 * `transaction_splits.linked_transaction_id`, and the far side points back at the
 * parent payment.
 */
function counterpartId(partner: number, context: Context): string | null {
  const throughParent = context.parentOfChild.get(partner);
  const target = throughParent ?? partner;
  return context.idByHandle.get(target) ?? null;
}

function mapSplitChild(
  child: MnyTransaction,
  context: Context,
): MappedSplit | null {
  const handle = child.handle;
  if (handle === null) {
    return null;
  }

  const partner = context.transfers.partnerByHandle.get(handle) ?? null;
  const partnerRow =
    partner === null ? null : (context.byHandle.get(partner) ?? null);
  const partnerKey = accountKeyOf(partnerRow, context.input);
  const partnerId = partner === null ? null : counterpartId(partner, context);

  // A split leg Money records in TRN_XFER is a transfer -- most often the
  // principal portion of a loan payment.
  if (partnerKey !== null && partnerId !== null) {
    return {
      kind: SplitKind.TRANSFER,
      categoryHandle: null,
      transferAccountKey: partnerKey,
      linkedTransactionId: partnerId,
      amount: child.amount,
      memo: child.memo,
    };
  }

  if (partner !== null) {
    // The counterpart is not being imported. Keeping the leg as a category split
    // preserves the parent's total; dropping it would not.
    context.warnings.push({
      code: "transferAcrossExcludedAccount",
      subject: `htrn=${handle}`,
      detail: `partner htrn=${partner}`,
      row: warningRow(child, context.input),
    });
  }

  return {
    kind: SplitKind.CATEGORY,
    categoryHandle: child.category,
    transferAccountKey: null,
    linkedTransactionId: null,
    amount: child.amount,
    memo: child.memo,
  };
}

function mapOne(
  row: MnyTransaction,
  accountKey: string,
  context: Context,
): MappedTransaction {
  const handle = row.handle as number;
  const splits = (context.childrenByParent.get(handle) ?? [])
    .map((child) => mapSplitChild(child, context))
    .filter((split): split is MappedSplit => split !== null);

  if (splits.length > 0) {
    const legTotal = roundMoney(
      splits.reduce((sum, split) => sum + split.amount, 0),
    );
    const total = roundMoney(row.amount);
    if (legTotal !== total) {
      context.warnings.push({
        code: "splitSumMismatch",
        subject: `htrn=${handle}`,
        detail: `legs ${legTotal} vs total ${total}`,
        row: warningRow(row, context.input),
      });
    }
  }

  // A split parent is never itself a transfer: its transfer legs are splits.
  const partner =
    splits.length > 0
      ? null
      : (context.transfers.partnerByHandle.get(handle) ?? null);
  const linkedTransactionId =
    partner === null ? null : counterpartId(partner, context);

  if (partner !== null && linkedTransactionId === null) {
    context.warnings.push({
      code: "transferAcrossExcludedAccount",
      subject: `htrn=${handle}`,
      detail: `partner htrn=${partner}`,
      row: warningRow(row, context.input),
    });
  }

  return {
    id: context.idByHandle.get(handle) as string,
    handle,
    accountKey,
    transactionDate: row.date as string,
    amount: row.amount,
    currencyCode:
      context.input.currencyByHandle.get(row.account as number) ?? "",
    status: mapTransactionStatus(row.clearedStatus, row.flags),
    payeeHandle: row.payee,
    // A split parent carries no category of its own: the legs do.
    categoryHandle: splits.length > 0 ? null : row.category,
    description: row.memo,
    referenceNumber: row.reference,
    isTransfer: linkedTransactionId !== null,
    linkedTransactionId,
    splits,
  };
}

/** Rows a real posting could not be made of, reported once each. */
function reportUnusable(
  rows: readonly MnyTransaction[],
  indexes: Indexes,
  input: MapTransactionsInput,
  warnings: MnyWarning[],
): number {
  let skipped = 0;

  for (const row of rows) {
    const handle = row.handle;
    if (
      handle === null ||
      indexes.parentOfChild.has(handle) ||
      indexes.billTemplates.has(handle) ||
      isRecurrenceTemplate(row.frequency) ||
      row.security !== null
    ) {
      continue;
    }

    if (indexes.transfers.orphanedHandles.has(handle)) {
      // A dangling TRN_XFER reference: Money's own phantom row.
      skipped += 1;
      warnings.push({
        code: "orphanedTransferSide",
        subject: `htrn=${handle}`,
        row: warningRow(row, input),
      });
      continue;
    }

    if (row.account === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${handle}`,
        detail: "no account",
        row: warningRow(row, input),
      });
      continue;
    }

    // An account the user left out is a choice, not a data problem.
    if (!input.accountKeyByHandle.has(row.account)) {
      continue;
    }

    if (row.date === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${handle}`,
        detail: "no usable date",
        row: warningRow(row, input),
      });
    }
  }

  return skipped;
}

/** Distinct transfer pairs where both top-level sides were imported. */
function countPlainTransferPairs(context: Context): number {
  const counted = new Set<number>();

  for (const [handle, partner] of context.transfers.partnerByHandle) {
    if (counted.has(handle) || counted.has(partner)) {
      continue;
    }
    if (
      context.idByHandle.has(handle) &&
      context.idByHandle.has(partner) &&
      !context.parentOfChild.has(handle) &&
      !context.parentOfChild.has(partner)
    ) {
      counted.add(handle);
      counted.add(partner);
    }
  }

  return counted.size / 2;
}

/**
 * Maps banking transactions, deferring anything that carries a security to the
 * investment mapper (Phase 2 reads the same tables).
 *
 * Every transaction id is pre-generated (design ADR-9) so transfer pairs and
 * transfer splits are fully wired before the first INSERT and the writer needs no
 * second pass to discover them.
 */
export function mapTransactions(
  input: MapTransactionsInput,
): MappedTransactions {
  const indexes = buildIndexes(input);
  const rows = input.transactions.transactions;
  const warnings = indexes.warnings;

  const idByHandle = new Map<number, string>(
    rows
      .filter((row) => isImportablePosting(row, indexes, input))
      .map((row) => [row.handle as number, randomUUID()]),
  );

  const context: Context = {
    input,
    byHandle: indexes.byHandle,
    parentOfChild: indexes.parentOfChild,
    childrenByParent: indexes.childrenByParent,
    billTemplates: indexes.billTemplates,
    transfers: indexes.transfers,
    idByHandle,
    warnings,
  };

  const transactions = rows
    .filter((row) => isImportablePosting(row, indexes, input))
    .map((row) => mapOne(row, accountKeyOf(row, input) as string, context));

  const referencedPayees = new Set(
    transactions
      .map((transaction) => transaction.payeeHandle)
      .filter((handle): handle is number => handle !== null),
  );
  const referencedCategories = new Set(
    transactions
      .flatMap((transaction) => [
        transaction.categoryHandle,
        ...transaction.splits.map((split) => split.categoryHandle),
      ])
      .filter((handle): handle is number => handle !== null),
  );

  const transferSplits = transactions.reduce(
    (count, transaction) =>
      count +
      transaction.splits.filter((split) => split.kind === SplitKind.TRANSFER)
        .length,
    0,
  );

  return {
    transactions,
    referencedPayees,
    referencedCategories,
    transfersLinked: countPlainTransferPairs(context) + transferSplits,
    skipped: reportUnusable(rows, indexes, input, warnings),
    deferredInvestments: rows.filter(
      (row) =>
        row.security !== null &&
        row.handle !== null &&
        !indexes.parentOfChild.has(row.handle) &&
        !isRecurrenceTemplate(row.frequency),
    ).length,
    warnings,
  };
}
