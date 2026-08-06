'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import { buildCategoryLabelMap } from '@/lib/categoryUtils';
import type { Category } from '@/types/category';

interface CategorySwitcherProps {
  /** The category currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Categories to switch between. Empty until the list has loaded. */
  categories: readonly Category[];
  onSelect: (id: string) => void;
}

/**
 * A caret beside the category's name that jumps straight to another one,
 * without going back to the list and clicking again. The menu, filter and
 * keyboard behaviour are `EntitySwitcher`'s; this only says what a category
 * row looks like. The filter matches the hierarchical "Parent: Child" label,
 * because a bare leaf name is ambiguous -- several parents can own a "Fees".
 */
export function CategorySwitcher({ currentId, categories, onSelect }: CategorySwitcherProps) {
  const t = useTranslations('categoryDetail');

  const items = useMemo<EntitySwitcherItem[]>(() => {
    const labelMap = buildCategoryLabelMap([...categories]);
    const byId = new Map(categories.map((c) => [c.id, c]));
    return categories.map((category) => ({
      id: category.id,
      primary: category.name,
      secondary: category.parentId
        ? byId.get(category.parentId)?.name
        : category.isIncome
          ? t('header.incomePill')
          : t('header.expensePill'),
      searchText: labelMap.get(category.id) ?? category.name,
    }));
  }, [categories, t]);

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('header.switchCategory')}
      filterPlaceholder={t('header.switchPlaceholder')}
      noMatchesLabel={t('header.switchNoMatches')}
    />
  );
}
