import { TransactionStatus, type Transaction } from '@/types/transaction';
import type { AccountType } from '@/types/account';
import type {
  ScheduledOccurrence,
  ScheduledTransaction,
} from '@/types/scheduled-transaction';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import { SCHEDULED_KIND_CHIP_CLASSES, occurrenceKind } from '@/lib/scheduled-kind';

/**
 * Putting the calendar's items on their days, and deciding how each chip looks.
 *
 * Grouping only. Nothing here adds, converts or compares money: a chip's
 * amount is the one the server sent for that row or that occurrence, and its
 * colour comes from the mapping that already owns the question
 * (`ACCOUNT_TYPE_META` for an account's type, `SCHEDULED_KIND_CHIP_CLASSES`
 * for an occurrence's kind). A second colour switch here would disagree with
 * the account list and the bills calendar the first time either changed.
 */

/** The calendar-relevant part of an account; the full row is never needed. */
export interface CalendarAccount {
  id: string;
  accountType: AccountType;
  linkedAccountId?: string | null;
}

export interface TransactionChip {
  key: string;
  transaction: Transaction;
  /** From `ACCOUNT_TYPE_META`, so a chip matches its account's pill. */
  className: string;
  /** A void row moved no balance, and is drawn struck through. */
  isVoid: boolean;
  /** Dated after the server's today; dimmed the way the register dims it. */
  isFuture: boolean;
}

export interface OccurrenceChip {
  key: string;
  occurrence: ScheduledOccurrence;
  schedule: ScheduledTransaction;
  /** From `SCHEDULED_KIND_CHIP_CLASSES`, by the occurrence's own direction. */
  className: string;
  /** Due before today and still unposted: the reader is behind on it. */
  isOverdue: boolean;
}

export interface CalendarDayRows {
  transactions: TransactionChip[];
  occurrences: OccurrenceChip[];
}

/** A row's calendar day, whether the server sent a date or a timestamp. */
export function rowDate(value: string): string {
  return value.split('T')[0];
}

/**
 * Group anything by the day it falls on, preserving the order it arrived in.
 *
 * The server already ordered the rows; re-sorting here would be a second
 * opinion about register order, which `applyRegisterOrder` owns.
 */
export function groupRowsByDay<T>(
  items: readonly T[],
  dateOf: (item: T) => string,
): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const day = dateOf(item);
    const existing = byDay.get(day);
    if (existing) existing.push(item);
    else byDay.set(day, [item]);
  }
  return byDay;
}

/**
 * How one real transaction is drawn.
 *
 * An account the client does not hold still gets a chip: the row is money that
 * moved, and dropping it because the accounts request answered short would
 * take a day's figures with it. It falls back to the neutral `OTHER` pill
 * rather than to a colour that would claim a type.
 */
export function chipForTransaction(
  transaction: Transaction,
  accountsById: ReadonlyMap<string, CalendarAccount>,
  today: string,
): TransactionChip {
  const accountType = accountsById.get(transaction.accountId)?.accountType ?? 'OTHER';
  return {
    key: transaction.id,
    transaction,
    className: ACCOUNT_TYPE_META[accountType].pillClass,
    isVoid: transaction.status === TransactionStatus.VOID,
    isFuture: rowDate(transaction.transactionDate) > today,
  };
}

/**
 * How one scheduled occurrence is drawn.
 *
 * The kind is `occurrenceKind`, which reads the server's resolved direction for
 * that occurrence and answers `unknown` when it cannot be derived. Nothing here
 * looks at the schedule's stored amount: that scalar was priced at whatever
 * rate was current when it was written (INV-OCCURRENCE-003).
 */
export function chipForOccurrence(
  occurrence: ScheduledOccurrence,
  schedule: ScheduledTransaction,
  today: string,
): OccurrenceChip {
  return {
    key: `${occurrence.scheduledTransactionId}:${occurrence.originalDate}`,
    occurrence,
    schedule,
    className: SCHEDULED_KIND_CHIP_CLASSES[occurrenceKind(occurrence, schedule)],
    isOverdue: rowDate(occurrence.dueDate) < today,
  };
}

/**
 * Every chip the Transactions calendar draws, keyed by day.
 *
 * An occurrence whose schedule the client does not hold is dropped: its chip
 * would have no name to print and no kind to colour, and inventing either is
 * worse than the schedule list arriving a moment later.
 */
export function groupCalendarRows(input: {
  transactions: readonly Transaction[];
  occurrences: readonly ScheduledOccurrence[];
  schedulesById: ReadonlyMap<string, ScheduledTransaction>;
  accountsById: ReadonlyMap<string, CalendarAccount>;
  today: string;
}): Map<string, CalendarDayRows> {
  const { transactions, occurrences, schedulesById, accountsById, today } = input;
  const days = new Map<string, CalendarDayRows>();

  const dayOf = (date: string): CalendarDayRows => {
    const existing = days.get(date);
    if (existing) return existing;
    const created: CalendarDayRows = { transactions: [], occurrences: [] };
    days.set(date, created);
    return created;
  };

  for (const transaction of transactions) {
    dayOf(rowDate(transaction.transactionDate)).transactions.push(
      chipForTransaction(transaction, accountsById, today),
    );
  }

  for (const occurrence of occurrences) {
    const schedule = schedulesById.get(occurrence.scheduledTransactionId);
    if (!schedule) continue;
    dayOf(rowDate(occurrence.dueDate)).occurrences.push(
      chipForOccurrence(occurrence, schedule, today),
    );
  }

  return days;
}
