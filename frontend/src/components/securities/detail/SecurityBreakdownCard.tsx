'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { SecurityWeightingBars } from './SecurityWeightingBars';
import type { Security } from '@/types/investment';

interface SecurityBreakdownCardProps {
  security: Security;
}

const DIMENSIONS = ['sector', 'country', 'assetClass'] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** The stored weightings behind each dimension, all `{ name, weight }` shaped. */
function slicesFor(security: Security, dimension: Dimension) {
  switch (dimension) {
    case 'sector':
      // The only one the provider fills in; its key is `sector`, not `name`.
      return security.sectorWeightings?.map((entry) => ({
        name: entry.sector,
        weight: entry.weight,
      }));
    case 'country':
      return security.countryWeightings;
    case 'assetClass':
      return security.assetWeightings;
  }
}

/**
 * What the instrument is made of, one dimension at a time.
 *
 * The three breakdowns share a card and a tab rather than stacking: they answer
 * the same shape of question, only one is worth reading at a time, and side by
 * side (or stacked) they would make the column beside the price chart several
 * times its height.
 *
 * Sector comes from the quote provider; country and asset class are the user's
 * own, entered when editing the security. Each is `{ name, weight }` with weight
 * a decimal 0-1, so one set of bars renders all three.
 */
export function SecurityBreakdownCard({ security }: SecurityBreakdownCardProps) {
  const t = useTranslations('securityDetail');
  const [dimension, setDimension] = useState<Dimension>('sector');

  const slices = slicesFor(security, dimension);

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('weightings.title')}
      </h3>

      <Tabs
        tabs={DIMENSIONS.map((key) => ({
          key,
          label: t(`weightings.${key}Tab` as Parameters<typeof t>[0]),
        }))}
        value={dimension}
        onChange={setDimension}
        idPrefix="securityBreakdown"
        ariaLabel={t('weightings.ariaLabel')}
      />

      {DIMENSIONS.map((key) => (
        <TabPanel
          key={key}
          idPrefix="securityBreakdown"
          tabKey={key}
          isActive={dimension === key}
          className="mt-3"
        >
          <SecurityWeightingBars
            slices={key === dimension ? slices : undefined}
            emptyMessage={t(
              `weightings.${key}Empty` as Parameters<typeof t>[0],
            )}
            remainderLabel={(percent) =>
              t('weightings.remainder', { percent })
            }
          />
        </TabPanel>
      ))}
    </div>
  );
}
