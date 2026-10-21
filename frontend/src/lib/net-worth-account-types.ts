import type { AccountType } from '@/types/account';
import type { MonthlyNetWorth } from '@/types/net-worth';
import { chartColors, chartSeriesColorAsidePrimary } from '@/lib/chart-colors';

/**
 * The Net Worth Over Time bar chart, stacked by account type: which types to
 * draw, in which order and colour. The figures are the server's
 * (`MonthlyNetWorth.byAccountType`); nothing here adds them up.
 */

/**
 * Stacking and legend order: what is held first, then what is owed, the order
 * the Accounts page groups them in. OTHER is last and neutral, as an
 * unclassified series is everywhere else.
 */
export const NET_WORTH_ACCOUNT_TYPE_ORDER: readonly AccountType[] = [
  'CHEQUING',
  'SAVINGS',
  'CASH',
  'INVESTMENT',
  'ASSET',
  'CREDIT_CARD',
  'LINE_OF_CREDIT',
  'LOAN',
  'MORTGAGE',
  'OTHER',
];

/**
 * One account type's colour, fixed by its place in the order so a type keeps
 * its colour whichever others a reader holds. The categorical palette skips
 * the accent, which the net worth line beside the bars is drawn in.
 */
export function netWorthAccountTypeColor(type: AccountType): string {
  if (type === 'OTHER') return chartColors.neutral;
  return chartSeriesColorAsidePrimary(NET_WORTH_ACCOUNT_TYPE_ORDER.indexOf(type));
}

/**
 * The account types any month of the series holds a non-zero amount in, in
 * stacking order. A type that is zero in every month (an emptied or paid-off
 * account) has nothing to draw, so it gets no bar and no legend entry. Empty
 * when no month carries the breakdown (an older backend mid-deploy), which the
 * chart reads as "draw net worth alone".
 */
export function netWorthAccountTypes(
  months: readonly Pick<MonthlyNetWorth, 'byAccountType'>[],
): AccountType[] {
  const present = new Set<AccountType>();
  for (const month of months) {
    for (const [type, value] of Object.entries(month.byAccountType ?? {})) {
      if (value !== undefined && value !== 0) present.add(type as AccountType);
    }
  }
  return NET_WORTH_ACCOUNT_TYPE_ORDER.filter((type) => present.has(type));
}

/**
 * Where a month's bar ends above zero: the sum of what its asset types hold,
 * the height a value label sits on. Only a position -- the figure printed there
 * is the server's `netWorth`. A month without the breakdown draws net worth as
 * one bar, which ends at net worth.
 */
export function netWorthStackTop(
  month: Pick<MonthlyNetWorth, 'byAccountType' | 'netWorth'>,
): number {
  if (!month.byAccountType) return month.netWorth;
  let top = 0;
  for (const value of Object.values(month.byAccountType)) {
    if (value !== undefined && value > 0) top += value;
  }
  return top;
}
