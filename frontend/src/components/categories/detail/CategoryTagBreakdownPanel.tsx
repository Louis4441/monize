'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { TagKeyBreakdownChart } from '@/components/transactions/TagKeyBreakdownChart';

interface CategoryTagBreakdownPanelProps {
  categoryId: string;
  /** Distinct KEY:VALUE tag keys in the user's tags (`collectTagKeys`). */
  tagKeys: string[];
  /** Bumped by the page on every reload so the chart refetches in lockstep. */
  refreshKey?: number;
}

/**
 * The category's spending broken down by the values of one KEY:VALUE tag key
 * (a `country:` or `project:` namespace, say). The page only renders this when
 * the user has such tags at all -- matching the register, which shows the same
 * chart only when a tag key is in play.
 */
export function CategoryTagBreakdownPanel({
  categoryId,
  tagKeys,
  refreshKey,
}: CategoryTagBreakdownPanelProps) {
  const t = useTranslations('categoryDetail');
  const [selectedKey, setSelectedKey] = useState(() => tagKeys[0] ?? '');

  const options = useMemo(
    () => tagKeys.map((key) => ({ value: key, label: key })),
    [tagKeys],
  );

  // The key list can arrive after mount (tags load in the page's supporting
  // effect); adopt the first key once it exists.
  const activeKey = selectedKey && tagKeys.includes(selectedKey) ? selectedKey : (tagKeys[0] ?? '');

  if (!activeKey) return null;

  return (
    <section>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('tagPanel.title')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('tagPanel.subtitle')}</p>
        </div>
        {tagKeys.length > 1 && (
          <div className="w-40 shrink-0">
            <Select
              aria-label={t('tagPanel.keyLabel')}
              options={options}
              value={activeKey}
              onChange={(event) => setSelectedKey(event.target.value)}
            />
          </div>
        )}
      </div>
      {/* Keyed so a key change (or a page reload) starts a fresh fetch. */}
      <TagKeyBreakdownChart
        key={`${activeKey}:${refreshKey ?? 0}`}
        tagKey={activeKey}
        params={{ categoryIds: [categoryId] }}
      />
    </section>
  );
}
