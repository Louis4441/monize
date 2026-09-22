import type { SortDirection } from '@/hooks/useSortableTable';
import { TransactionStatus } from '@/types/transaction';

/** What the walk needs of a row; typed structurally so a test fixture is honest. */
export interface RunningBalanceRow {
  id: string;
  amount: number | string;
  status?: TransactionStatus | null;
  parentTransactionId?: string | null;
}

/**
 * Whether the row moved the account's balance.
 *
 * A VOID row records something that did not happen and a split child is not a
 * movement -- its parent already carries the total. Both still occupy a line
 * in the register, so they take a balance from the row above rather than
 * being skipped.
 */
export function rowAffectsBalance(row: RunningBalanceRow): boolean {
  return row.status !== TransactionStatus.VOID && !row.parentTransactionId;
}

/**
 * The balance to print beside each row of one page.
 *
 * The server sends one number: `startingBalance`, the balance **after the
 * newest row on this page**. The walk runs from there, newest row first,
 * subtracting each row as it goes -- so an oldest-first page is reversed
 * before it is walked, which is the whole of what sorting ascending changes
 * here. The result is keyed by id, so the caller renders in whatever order it
 * received.
 *
 * Money accumulates in integers (`AGENTS.md`): summing fifty floats down a
 * page drifts a cent, and a register is exactly where a reader would notice.
 *
 * An absent or unusable seed returns an empty map rather than zeroes: no
 * balance is not a balance of nothing, and the cell renders as unknown.
 */
export function walkRunningBalances(
  rows: readonly RunningBalanceRow[],
  startingBalance: number | undefined,
  direction: SortDirection,
  displayAmounts?: ReadonlyMap<string, number>,
): Map<string, number> {
  const balances = new Map<string, number>();
  const seed = Number(startingBalance);
  if (startingBalance === undefined || isNaN(seed) || rows.length === 0) {
    return balances;
  }

  const newestFirst = direction === 'asc' ? [...rows].reverse() : rows;
  const seedCents = Math.round(seed * 10000);
  let cumulativeCents = 0;

  for (const row of newestFirst) {
    balances.set(row.id, (seedCents - cumulativeCents) / 10000);
    if (rowAffectsBalance(row)) {
      const raw = displayAmounts?.get(row.id) ?? Number(row.amount);
      cumulativeCents += isNaN(raw) ? 0 : Math.round(raw * 10000);
    }
  }

  return balances;
}
