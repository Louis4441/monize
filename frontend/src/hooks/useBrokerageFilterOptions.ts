'use client';

import { useEffect, useRef, useState } from 'react';
import { investmentsApi } from '@/lib/investments';
import { createLogger } from '@/lib/logger';

const logger = createLogger('BrokerageFilterOptions');

const NO_ACTIONS: string[] = [];

/**
 * The actions a brokerage register can be narrowed by: the ones its own rows
 * use, fetched for the accounts on screen.
 *
 * The sibling of `useCashFilterOptions`
 * (`components/investments/CashRegisterFilters.tsx`), and for the same reason:
 * a picker offering the whole vocabulary to narrow six rows is a list to read
 * rather than a filter to use. The two registers of one account therefore ask
 * the same question of their own rows, each in its own terms.
 *
 * An empty array while it loads (and after a failure) is the right thing for
 * this one: the list falls back to the full vocabulary when it is handed
 * nothing, so a slow or failed lookup leaves the picker as it has always been
 * rather than emptying it. The failure does not latch -- the next change of
 * accounts asks again.
 */
export function useBrokerageFilterOptions(accountIds: string[]): string[] {
  const [actions, setActions] = useState<string[]>(NO_ACTIONS);
  // Which request the actions on screen answered, so a re-render does not
  // re-ask and a changed account set does.
  const loadedKeyRef = useRef<string | null>(null);
  const key = [...accountIds].sort().join(',');

  useEffect(() => {
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    let cancelled = false;
    investmentsApi
      .getRegisterFilterOptions(accountIds)
      .then((options) => {
        if (!cancelled) setActions(options.actions);
      })
      .catch((error) => {
        logger.error('Failed to load brokerage filter options:', error);
        if (loadedKeyRef.current === key) loadedKeyRef.current = null;
      });
    return () => {
      cancelled = true;
    };
    // `accountIds` is a fresh array on every render; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return actions;
}
