'use client';

import { useTranslations } from 'next-intl';
import { CheckIcon } from '@heroicons/react/24/outline';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { GemAssetRole, GemCadence, GemSignal } from '@/types/gem-strategy';
import { GEM_ROLE_COLOURS } from '@/lib/gem-strategy-view';
import { GemCard, GemDonut, GemEmptyState } from './GemPrimitives';
import { useGemLabels } from './useGemLabels';

interface GemAllocationCardProps {
  signal: GemSignal | null;
  winnerRole: GemAssetRole | null;
  cadence: GemCadence;
}

/**
 * The target allocation the signal implies, plus the three rules that produce
 * it. Deliberately short: the instrument details, dates and portfolio state are
 * already covered by the summary cards above.
 */
export function GemAllocationCard({ signal, winnerRole, cadence }: GemAllocationCardProps) {
  const t = useTranslations('strategies');
  const { cadenceLabel, assetLabel } = useGemLabels();
  const { formatPercent } = useNumberFormat();

  if (!signal) {
    return (
      <GemCard title={t('gem.allocation.title')} hint={t('gem.allocation.hint')}>
        <GemEmptyState
          title={t('gem.allocation.noSignalTitle')}
          description={t('gem.allocation.noSignalDescription')}
        />
      </GemCard>
    );
  }

  const colour = winnerRole ? GEM_ROLE_COLOURS[winnerRole] : 'var(--chart-1)';
  const rules = [
    t('gem.allocation.ruleCadence', { cadence: cadenceLabel(cadence) }),
    t('gem.allocation.ruleTwoSteps'),
    t('gem.allocation.ruleSingleAsset'),
  ];

  return (
    <GemCard title={t('gem.allocation.title')} hint={t('gem.allocation.hint')}>
      <div className="flex items-center gap-4">
        <GemDonut
          segments={[
            { key: 'target', percent: signal.targetWeightPercent, colour },
          ]}
          centreValue={formatPercent(signal.targetWeightPercent, 0)}
          centreLabel={assetLabel(signal.target)}
          ariaLabel={t('gem.allocation.donutAriaLabel', {
            weight: signal.targetWeightPercent,
            asset: assetLabel(signal.target),
          })}
          size={84}
          thickness={11}
        />
        <ul className="min-w-0 flex-1 space-y-1.5 text-xs text-gray-600 dark:text-gray-300">
          {rules.map((rule) => (
            <li key={rule} className="flex items-start gap-1.5">
              <CheckIcon
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500"
                aria-hidden="true"
              />
              <span>{rule}</span>
            </li>
          ))}
        </ul>
      </div>
    </GemCard>
  );
}
