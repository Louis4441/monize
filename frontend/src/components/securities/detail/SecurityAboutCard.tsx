'use client';

import { useTranslations } from 'next-intl';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import type { Security } from '@/types/investment';

interface SecurityAboutCardProps {
  security: Security;
}

/**
 * What the instrument is, in prose plus the classification fields.
 *
 * Website and IR website are laid out here but have no column on `securities`
 * yet, so they show a placeholder rather than a fabricated link. Whether they
 * become real fields or come off the card is a decision for the maintainer once
 * the page's shape is agreed (discussion #964).
 */
export function SecurityAboutCard({ security }: SecurityAboutCardProps) {
  const t = useTranslations('securityDetail');

  const countries = security.countryWeightings
    ?.map((entry) => entry.name)
    .filter(Boolean)
    .join(', ');

  const notStored = (
    <span className="text-gray-500 dark:text-gray-400">
      {t('about.notStored')}
    </span>
  );

  const rows: KeyValueRow[] = [
    { key: 'sector', label: t('about.sector'), value: security.sector },
    { key: 'industry', label: t('about.industry'), value: security.industry },
    { key: 'country', label: t('about.country'), value: countries || null },
    { key: 'website', label: t('about.website'), value: notStored },
    { key: 'irWebsite', label: t('about.irWebsite'), value: notStored },
    {
      key: 'tags',
      label: t('about.tags'),
      value:
        security.tags && security.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {security.tags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
                style={{
                  backgroundColor: tag.color ? `${tag.color}20` : '#9ca3af20',
                  color: tag.color || '#6b7280',
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        ) : null,
    },
  ];

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('about.title')}
      </h3>
      <p
        className={`text-sm ${
          security.description
            ? 'text-gray-700 dark:text-gray-300'
            : 'text-gray-500 dark:text-gray-400'
        }`}
      >
        {security.description || t('about.noDescription')}
      </p>
      <KeyValueList rows={rows} variant="pairs" className="mt-4" />
    </div>
  );
}
