'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { GemAssetMomentum, GemSignal } from '@/types/gem-strategy';
import {
  GEM_ROLE_COLOURS,
  isKnown,
  momentumBarWidth,
} from '@/lib/gem-strategy-view';
import { cn } from '@/lib/utils';
import {
  GemBadge,
  GemBar,
  GemCard,
  GemEmptyState,
  GemSecurityLink,
  GemSigned,
  GemSwatch,
} from './GemPrimitives';
import { useGemLabels } from './useGemLabels';

interface GemReasoningSectionProps {
  signal: GemSignal | null;
  /** Momentum window the figures were computed over, in months. */
  lookbackMonths: number;
}

/**
 * Question 2 of the report: why this instrument? Lays the two GEM decisions out
 * in order -- absolute momentum (equities versus the risk-free asset), then the
 * relative ranking that only matters while RISK-ON -- using the numbers the
 * server evaluated the signal with.
 */
export function GemReasoningSection({
  signal,
  lookbackMonths,
}: GemReasoningSectionProps) {
  const t = useTranslations('strategies');
  const { roleLabel, stateLabel, assetLabel } = useGemLabels();
  const { formatSignedPercent, formatNumber } = useNumberFormat();

  if (!signal) {
    return (
      <GemCard title={t('gem.reasoning.title')} hint={t('gem.reasoning.hint')}>
        <GemEmptyState
          title={t('gem.reasoning.noSignalTitle')}
          description={t('gem.reasoning.noSignalDescription')}
        />
      </GemCard>
    );
  }

  const { absolute, relative } = signal;
  const isRiskOn = absolute.result === 'RISK_ON';
  const formatPp = (value: number) =>
    t('gem.common.pp', { value: `${value >= 0 ? '+' : '-'}${formatNumber(Math.abs(value), 2)}` });

  const absoluteValues = [absolute.equity.momentum12m, absolute.benchmark.momentum12m];

  /** One momentum row: label, coloured bar and the signed 12-month figure. */
  const momentumRow = (asset: GemAssetMomentum, values: Array<number | null>, rank?: number) => (
    <div key={`${asset.role}-${rank ?? ''}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center gap-2">
        {rank !== undefined && (
          <span className="w-4 shrink-0 text-xs font-semibold text-gray-500 dark:text-gray-400">
            {rank}.
          </span>
        )}
        <GemSwatch colour={GEM_ROLE_COLOURS[asset.role]} />
        <span className="truncate text-sm text-gray-700 dark:text-gray-200">
          {roleLabel(asset.role)}
          {asset.symbol && (
            <GemSecurityLink
              securityId={asset.securityId}
              className="text-gray-500 dark:text-gray-400"
            >
              {' '}
              ({asset.symbol})
            </GemSecurityLink>
          )}
        </span>
      </div>
      <span className="text-sm font-medium tabular-nums">
        <GemSigned value={asset.momentum12m} format={(value) => formatSignedPercent(value)} />
      </span>
      <div className="col-span-2">
        <GemBar
          width={momentumBarWidth(asset.momentum12m, values)}
          negative={isKnown(asset.momentum12m) && asset.momentum12m < 0}
        />
      </div>
    </div>
  );

  return (
    <GemCard title={t('gem.reasoning.title')} hint={t('gem.reasoning.hint')}>
      <div className="grid gap-4 md:grid-cols-2 md:divide-x md:divide-gray-200 md:dark:divide-gray-700">
        {/* Step 1 -- absolute momentum */}
        <div className="md:pr-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('gem.reasoning.step1Title')}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('gem.reasoning.step1Subtitle', {
                  months: lookbackMonths,
                  equity: assetLabel(absolute.equity),
                  benchmark: assetLabel(absolute.benchmark),
                })}
              </p>
            </div>
            <GemBadge tone={isRiskOn ? 'green' : 'gray'}>
              {t('gem.reasoning.result', { result: stateLabel(absolute.result) })}
            </GemBadge>
          </div>

          <div className="space-y-2">
            {momentumRow(absolute.equity, absoluteValues)}
            {momentumRow(absolute.benchmark, absoluteValues)}
          </div>

          <div className="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-2 text-sm dark:border-gray-700">
            <span className="text-gray-600 dark:text-gray-300">
              {t('gem.reasoning.equityAdvantage')}
            </span>
            <span className="font-semibold tabular-nums">
              <GemSigned value={absolute.spreadPp} format={formatPp} />
            </span>
          </div>

          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {isKnown(absolute.spreadPp) ? (
              isRiskOn ? (
                <>
                  {t('gem.reasoning.buffer', { value: formatNumber(Math.abs(absolute.spreadPp), 2) })}{' '}
                  {t('gem.reasoning.bufferExplainerRiskOn')}
                </>
              ) : (
                <>
                  {t('gem.reasoning.gap', { value: formatNumber(Math.abs(absolute.spreadPp), 2) })}{' '}
                  {t('gem.reasoning.bufferExplainerRiskOff')}
                </>
              )
            ) : (
              t('gem.reasoning.bufferUnknown', { months: lookbackMonths })
            )}
          </p>
        </div>

        {/* Step 2 -- relative momentum. Dimmed and annotated while RISK-OFF. */}
        <div className={cn('md:pl-4', !relative.applied && 'opacity-60')}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('gem.reasoning.step2Title')}
                <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">
                  {t('gem.reasoning.step2Condition')}
                </span>
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('gem.reasoning.step2Subtitle', {
                  count: relative.ranking.length,
                  months: lookbackMonths,
                })}
              </p>
            </div>
            {relative.applied ? (
              <GemBadge tone="gray">
                {t('gem.reasoning.result', {
                  result: t('gem.reasoning.winnerAllocation', {
                    weight: signal.targetWeightPercent,
                    asset: assetLabel(relative.winner),
                  }),
                })}
              </GemBadge>
            ) : (
              <GemBadge tone="gray">{t('gem.reasoning.notApplied')}</GemBadge>
            )}
          </div>

          {relative.ranking.length === 0 ? (
            <GemEmptyState
              title={t('gem.reasoning.noRankingTitle')}
              description={t('gem.reasoning.noRankingDescription')}
            />
          ) : (
            <div className="space-y-2">
              {relative.ranking.map((asset, index) =>
                momentumRow(
                  asset,
                  relative.ranking.map((item) => item.momentum12m),
                  asset.rank ?? index + 1,
                ),
              )}
            </div>
          )}

          <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {!relative.applied
              ? t('gem.reasoning.riskOffExplainer')
              : isKnown(relative.leadPp) && relative.ranking.length > 1
                ? t('gem.reasoning.lead', {
                    winner: assetLabel(relative.winner),
                    runnerUp: assetLabel(relative.ranking[1]),
                    value: formatNumber(Math.abs(relative.leadPp), 2),
                  })
                : t('gem.reasoning.leadUnknown')}
          </p>
        </div>
      </div>
    </GemCard>
  );
}
