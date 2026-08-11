'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import { formatAccountType } from '@/lib/account-utils';
import { buildLogicalAccounts } from '@/lib/logical-accounts';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import type { Account } from '@/types/account';

interface AccountSwitcherProps {
  /** The account currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Accounts to switch between. Empty until the list has loaded. */
  accounts: readonly Account[];
  onSelect: (id: string) => void;
}

/**
 * A caret beside the account's name that jumps straight to another one, without
 * going back to the list. The menu, filter and keyboard behaviour are
 * `EntitySwitcher`'s; this only says what an account row looks like.
 */
export function AccountSwitcher({ currentId, accounts, onSelect }: AccountSwitcherProps) {
  const t = useTranslations('accountDetail');
  const tc = useTranslations('common');
  const stripAccountName = useMainAccountName();

  // A linked brokerage/cash pair is one account, so it is one entry here --
  // otherwise the switcher offers the same account twice, under two names the
  // user never chose.
  const logicalAccounts = useMemo(
    () => buildLogicalAccounts([...accounts], stripAccountName),
    [accounts, stripAccountName],
  );

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      logicalAccounts.map((logical) => {
        const type = formatAccountType(logical.primary.accountType, tc);
        const storedNames = logical.cash
          ? `${logical.primary.name} ${logical.cash.name}`
          : logical.primary.name;
        return {
          id: logical.id,
          primary: logical.displayName,
          // The type disambiguates the several accounts a reader names alike
          // ("Joint" at two banks), the same way the payee switcher shows a
          // default category.
          secondary: type,
          // Either ledger's stored name still finds the account it belongs to.
          searchText: `${logical.displayName} ${storedNames} ${type}`,
        };
      }),
    [logicalAccounts, tc],
  );

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('header.switchAccount')}
      filterPlaceholder={t('header.switchPlaceholder')}
      noMatchesLabel={t('header.switchNoMatches')}
    />
  );
}
