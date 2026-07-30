'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import { formatAccountType } from '@/lib/account-utils';
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

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      accounts.map((account) => {
        const type = formatAccountType(account.accountType, tc);
        return {
          id: account.id,
          primary: account.name,
          // The type disambiguates the several accounts a reader names alike
          // ("Joint" at two banks), the same way the payee switcher shows a
          // default category.
          secondary: type,
          searchText: `${account.name} ${type}`,
        };
      }),
    [accounts, tc],
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
