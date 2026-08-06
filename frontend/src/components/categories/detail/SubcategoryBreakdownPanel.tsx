'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { TopGroupsPanel } from '@/components/accounts/shared/TopGroupsPanel';
import type { SubcategoryShare } from '@/lib/categoryUtils';
import type { GroupedTotal } from '@/types/transaction';

interface SubcategoryBreakdownPanelProps {
  /** Direct-child buckets from `rollupToDirectChildren`; [] for a leaf. */
  shares: SubcategoryShare[];
  currencyCode: string;
  isLoading: boolean;
  /** Open a child category's own detail page. */
  onSelectChild: (categoryId: string) => void;
}

/**
 * Where the money in this category actually lands: one bar per direct child
 * (each covering its whole subtree), plus a "This category" bucket for rows
 * filed on the category itself. A child's bar links to its own detail page;
 * the "This category" bucket is where the reader already is, so it does not.
 */
export function SubcategoryBreakdownPanel({
  shares,
  currencyCode,
  isLoading,
  onSelectChild,
}: SubcategoryBreakdownPanelProps) {
  const t = useTranslations('categoryDetail');

  // The self bucket's name is null-ed so TopGroupsPanel renders it with the
  // fallback label and leaves it unselectable -- clicking "This category"
  // would navigate to the page the reader is on.
  const totals = useMemo<GroupedTotal[]>(
    () =>
      shares.map((share) => ({
        id: share.name === null ? null : share.id,
        name: share.name,
        currencyCode,
        total: share.total,
        count: share.count,
      })),
    [shares, currencyCode],
  );

  return (
    <TopGroupsPanel
      title={t('subcategoriesPanel.title')}
      subtitle={t('subcategoriesPanel.subtitle')}
      emptyLabel={t('subcategoriesPanel.empty')}
      fallbackLabel={t('subcategoriesPanel.thisCategory')}
      totals={totals}
      currencyCode={currencyCode}
      isLoading={isLoading}
      onSelect={(id) => {
        if (id) onSelectChild(id);
      }}
    />
  );
}
