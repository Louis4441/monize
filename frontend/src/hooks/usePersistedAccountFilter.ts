'use client';

import { useState } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';

type AccountLike = { id: string };

const NO_SELECTION: string[] = [];
const NO_ACCOUNTS: AccountLike[] = [];

/**
 * Account filter for a report, persisted to localStorage so the report opens
 * on the same accounts the user last looked at instead of resetting to "All
 * Accounts" on every visit.
 *
 * IDs are pruned against the report's account list once it loads, so an
 * account that has since been deleted (or is no longer offered by the report)
 * can't leave the report filtered on something that does not exist. Pruning
 * keys off the account IDs rather than the array identity, because most
 * reports rebuild their account list on every load.
 *
 * Reports that already have their account list when they call this hook pass
 * it as `accounts`. Reports that load accounts alongside their data -- so the
 * list only exists further down the component -- pass nothing and call the
 * returned `pruneAgainst(accounts)` there instead. Do both and the two lists
 * would fight each other, so pick one.
 *
 * Pruning runs during render (this project forbids setState inside effects);
 * setting state on the component currently rendering is React's sanctioned way
 * to derive state from changed inputs, and the ID key bounds it to one extra
 * render per account-list change.
 */
export function usePersistedAccountFilter(
  storageKey: string,
  accounts: ReadonlyArray<AccountLike> = NO_ACCOUNTS,
): [string[], (value: string[]) => void, (accounts: ReadonlyArray<AccountLike>) => void] {
  const [stored, setStored] = useLocalStorage<string[]>(storageKey, NO_SELECTION);
  // Guard against a hand-edited or legacy localStorage entry of the wrong
  // shape. NO_SELECTION keeps the identity stable so callers can safely use
  // the selection as an effect dependency.
  const selectedIds = Array.isArray(stored) ? stored : NO_SELECTION;

  const [prunedAgainst, setPrunedAgainst] = useState<string | null>(null);

  const pruneAgainst = (list: ReadonlyArray<AccountLike>) => {
    if (list.length === 0) return;
    const listKey = list.map((a) => a.id).join(',');
    if (listKey === prunedAgainst) return;
    setPrunedAgainst(listKey);
    const knownIds = new Set(list.map((a) => a.id));
    const kept = selectedIds.filter((id) => knownIds.has(id));
    if (kept.length !== selectedIds.length) {
      setStored(kept);
    }
  };

  pruneAgainst(accounts);

  return [selectedIds, setStored, pruneAgainst];
}

/**
 * Single-account variant for the reports that analyse one account at a time
 * (loan amortization, debt payoff, overpayment simulator).
 *
 * A stored account that is no longer in `accounts` -- deleted, or paid off and
 * closed -- reads back as no selection, leaving the caller's own fallback (the
 * first account, or none) to take over. That makes this a pure derivation: no
 * pruning write, so nothing to keep in step with the account list.
 */
export function usePersistedAccountId(
  storageKey: string,
  accounts: ReadonlyArray<AccountLike>,
): [string, (id: string) => void] {
  const [stored, setStored] = useLocalStorage<string>(storageKey, '');
  const persistedId = typeof stored === 'string' ? stored : '';
  const selectedId = accounts.some((a) => a.id === persistedId) ? persistedId : '';
  return [selectedId, setStored];
}
