'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import { buildCategoryTree } from '@/lib/categoryUtils';
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
 * without going back to the list and clicking again.
 *
 * The list is the same one the transaction form's Category dropdown offers:
 * every category in tree order, a child labelled "Parent: Child" and a
 * top-level category by its bare name -- and every row, parents included, is
 * selectable. A bare leaf name would be ambiguous (several parents can own a
 * "Fees"), and a differently-shaped list here would make the same picker read
 * two ways in one app. The filter matches the full hierarchical label.
 */
export function CategorySwitcher({ currentId, categories, onSelect }: CategorySwitcherProps) {
  const t = useTranslations('categoryDetail');

  const items = useMemo<EntitySwitcherItem[]>(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    // Tree order (each parent followed by its children, alphabetical per
    // level), exactly as the transaction form builds its category options.
    return buildCategoryTree([...categories]).map(({ category }) => {
      const parent = category.parentId ? byId.get(category.parentId) : null;
      const label = parent ? `${parent.name}: ${category.name}` : category.name;
      return {
        id: category.id,
        primary: label,
        searchText: label,
      };
    });
  }, [categories]);

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
