'use client';

import { useMemo } from 'react';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import {
  buildLogicalAccounts,
  toLogicalAccountPortfolio,
  LogicalAccount,
} from '@/lib/logical-accounts';
import { Account } from '@/types/account';
import { PortfolioSummary } from '@/types/investment';

/**
 * Fold an account list into logical accounts, with the localized pair-name
 * suffix stripped and each investment entity's combined value resolved.
 *
 * Pass the portfolio summary whenever the surface has one. Passing `null` or
 * `undefined` (not loaded, or the request failed) leaves every investment
 * entity's `combinedValue` unknown rather than reporting its cash alone.
 */
export function useLogicalAccounts(
  accounts: Account[],
  portfolioSummary?: PortfolioSummary | null,
): LogicalAccount[] {
  const stripName = useMainAccountName();
  return useMemo(
    () =>
      buildLogicalAccounts(
        accounts,
        stripName,
        toLogicalAccountPortfolio(portfolioSummary?.holdingsByAccount),
      ),
    [accounts, stripName, portfolioSummary],
  );
}
