/**
 * What a scheduled transaction *is*, as far as any surface listing upcoming
 * occurrences is concerned.
 *
 * The sign of the amount answers only two of the four cases. A transfer moves
 * money between the user's own accounts and is neither a bill nor a deposit,
 * and an amount of exactly zero is a deliberate placeholder -- a reminder for
 * something whose amount is not known until it arrives (a credit card bill, a
 * variable utility). Both are real schedules with real due dates, so both
 * belong on a calendar; classifying with a bare `amount < 0` / `amount > 0`
 * pair silently drops them.
 */
export type ScheduledKind = 'bill' | 'deposit' | 'transfer' | 'reminder';

export function scheduledKind(st: {
  amount: number | string;
  isTransfer?: boolean;
}): ScheduledKind {
  if (st.isTransfer) return 'transfer';
  const amount = Number(st.amount);
  if (!Number.isFinite(amount)) return 'reminder';
  if (amount < 0) return 'bill';
  if (amount > 0) return 'deposit';
  return 'reminder';
}

/**
 * The kind of ONE occurrence.
 *
 * Kind is a question about direction, and an exchange rate is positive, so the
 * stored sign classifies correctly even when the occurrence's own magnitude is
 * unknown -- which is why an unknown amount falls back to the schedule's sign
 * rather than to `Number(null)`, whose zero would paint an unpriceable bill as a
 * grey reminder (issue #1247). The magnitude never comes from the schedule: use
 * the occurrence's `amount` for that, and `UnknownAmount` when it is null.
 */
export function occurrenceKind(
  occurrence: { amount: number | null },
  schedule: { amount: number | string; isTransfer?: boolean },
): ScheduledKind {
  return scheduledKind({
    amount: occurrence.amount ?? Number(schedule.amount),
    isTransfer: schedule.isTransfer,
  });
}

/**
 * Chip styling for a calendar occurrence, so the Bills & Deposits calendar and
 * the Upcoming Bills report read the same way. Red is spending, green is money
 * arriving, blue is a transfer between the user's own accounts, and grey is a
 * zero-amount reminder -- which must not be painted as a deposit merely because
 * it is not negative.
 */
export const SCHEDULED_KIND_CHIP_CLASSES: Record<ScheduledKind, string> = {
  bill: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  deposit: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  transfer: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  reminder: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

/** Text colour for the amount printed beside an occurrence, by the same rule. */
export const SCHEDULED_KIND_AMOUNT_CLASSES: Record<ScheduledKind, string> = {
  bill: 'text-red-600 dark:text-red-400',
  deposit: 'text-green-600 dark:text-green-400',
  transfer: 'text-blue-600 dark:text-blue-400',
  reminder: 'text-gray-500 dark:text-gray-400',
};
