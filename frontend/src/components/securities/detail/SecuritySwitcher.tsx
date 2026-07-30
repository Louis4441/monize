'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { Security } from '@/types/investment';

interface SecuritySwitcherProps {
  /** The security currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Securities to switch between. Empty until the list has loaded. */
  securities: readonly Security[];
  onSelect: (id: string) => void;
}

/**
 * A caret beside the security's name that jumps straight to another one,
 * without going back to the list and picking Details again. The menu, filter
 * and keyboard behaviour are `EntitySwitcher`'s; this only says what a security
 * row looks like and what the filter matches.
 */
export function SecuritySwitcher({
  currentId,
  securities,
  onSelect,
}: SecuritySwitcherProps) {
  const t = useTranslations('securityDetail');

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      securities.map((security) => ({
        id: security.id,
        primary: security.symbol,
        secondary: security.name,
        // A reader reaches for either the ticker or the name, so both match.
        searchText: `${security.symbol} ${security.name}`,
      })),
    [securities],
  );

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('header.switchSecurity')}
      filterPlaceholder={t('header.switchPlaceholder')}
      noMatchesLabel={t('header.switchNoMatches')}
      secondaryAlign="inline"
    />
  );
}
