'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { Payee } from '@/types/payee';

interface PayeeSwitcherProps {
  /** The payee currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Payees to switch between. Empty until the list has loaded. */
  payees: readonly Payee[];
  onSelect: (id: string) => void;
}

/**
 * A caret beside the payee's name that jumps straight to another one, without
 * going back to the list and clicking again. The menu, filter and keyboard
 * behaviour are `EntitySwitcher`'s; this only says what a payee row looks like.
 */
export function PayeeSwitcher({ currentId, payees, onSelect }: PayeeSwitcherProps) {
  const t = useTranslations('payeeDetail');

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      payees.map((payee) => ({
        id: payee.id,
        primary: payee.name,
        secondary: payee.defaultCategory?.name,
      })),
    [payees],
  );

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('header.switchPayee')}
      filterPlaceholder={t('header.switchPlaceholder')}
      noMatchesLabel={t('header.switchNoMatches')}
    />
  );
}
