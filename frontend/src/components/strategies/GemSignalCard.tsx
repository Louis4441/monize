'use client';

import { useTranslations } from 'next-intl';
import { ArrowTrendingUpIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { useDateFormat } from '@/hooks/useDateFormat';
import { GemSignal } from '@/types/gem-strategy';
import { isKnown } from '@/lib/gem-strategy-view';
import { GemBadge, GemCard, GemEmptyState, GemSecurityLink } from './GemPrimitives';
import { useGemLabels } from './useGemLabels';

interface GemSignalCardProps {
  signal: GemSignal | null;
  nextEvaluationOn: string | null;
  daysUntilNextEvaluation: number | null;
  /** True when the strategy has never been evaluated yet. */
  firstRun: boolean;
  /** True when the server could not evaluate the signal. */
  failed: boolean;
}

/**
 * Question 1 of the report: what is the current signal? The most prominent card
 * in the row -- an active signal is marked with a subtle green edge and a
 * text RISK-ON / RISK-OFF badge, never a colour-filled card.
 */
export function GemSignalCard({
  signal,
  nextEvaluationOn,
  daysUntilNextEvaluation,
  firstRun,
  failed,
}: GemSignalCardProps) {
  const t = useTranslations('strategies');
  const { stateLabel, assetFullLabel } = useGemLabels();
  const { formatDate } = useDateFormat();

  if (!signal) {
    return (
      <GemCard title={t('gem.signal.title')} hint={t('gem.signal.hint')}>
        <GemEmptyState
          title={failed ? t('gem.signal.failedTitle') : t('gem.signal.firstRunTitle')}
          description={
            failed
              ? t('gem.signal.failedDescription')
              : firstRun
                ? t('gem.signal.firstRunDescription')
                : t('gem.signal.unavailableDescription')
          }
        />
      </GemCard>
    );
  }

  const isRiskOn = signal.state === 'RISK_ON';
  const Icon = isRiskOn ? ArrowTrendingUpIcon : ShieldCheckIcon;

  return (
    <GemCard
      title={t('gem.signal.title')}
      hint={t('gem.signal.hint')}
      headerRight={
        <GemBadge tone={isRiskOn ? 'green' : 'gray'}>{stateLabel(signal.state)}</GemBadge>
      }
    >
      {/* The badge above states RISK-ON/RISK-OFF; the allocation itself reads
          as an ordinary heading rather than a coloured one. */}
      <p className="text-lg font-semibold leading-tight text-gray-900 dark:text-gray-100">
        {t('gem.signal.allocation', {
          weight: signal.targetWeightPercent,
          asset: signal.target?.name ?? signal.target?.symbol ?? t('gem.common.unassigned'),
        })}
      </p>
      <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
        <GemSecurityLink securityId={signal.target?.securityId}>
          {assetFullLabel(signal.target)}
        </GemSecurityLink>
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">{t('gem.signal.effectiveFrom')}</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">
            {formatDate(signal.effectiveFrom)}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">{t('gem.signal.nextEvaluation')}</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">
            {nextEvaluationOn
              ? isKnown(daysUntilNextEvaluation)
                ? t('gem.signal.nextEvaluationValue', {
                    date: formatDate(nextEvaluationOn),
                    days: daysUntilNextEvaluation,
                  })
                : formatDate(nextEvaluationOn)
              : t('gem.header.nextEvaluationUnknown')}
          </dd>
        </div>
      </dl>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {isRiskOn
          ? t('gem.signal.testsRiskOn')
          : t('gem.signal.testsRiskOff')}
      </p>
    </GemCard>
  );
}
