'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { GemBacktestSummary } from '@/types/gem-strategy';
import { GemCard, GemEmptyState, GemSigned, GemStatRow, GemUnknown } from './GemPrimitives';

interface GemBacktestPanelProps {
  backtest: GemBacktestSummary | null;
}

/**
 * "Backtest" tab: the net-of-cost simulation summary for the configured asset
 * set, when the server has one. Without it the tab explains what is missing
 * rather than showing zeroed metrics.
 */
export function GemBacktestPanel({ backtest }: GemBacktestPanelProps) {
  const t = useTranslations('strategies');
  const { formatDate } = useDateFormat();
  const { formatSignedPercent, formatPercent } = useNumberFormat();

  if (!backtest) {
    return (
      <GemCard title={t('gem.backtest.title')}>
        <GemEmptyState
          title={t('gem.backtest.emptyTitle')}
          description={t('gem.backtest.emptyDescription')}
        />
      </GemCard>
    );
  }

  return (
    <GemCard title={t('gem.backtest.title')} hint={t('gem.backtest.hint')}>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        {t('gem.backtest.period', {
          from: formatDate(backtest.from),
          to: formatDate(backtest.to),
        })}
      </p>
      <dl className="space-y-1">
        <GemStatRow
          label={t('gem.backtest.cagr')}
          value={
            <GemSigned value={backtest.cagrPercent} format={(value) => formatSignedPercent(value)} />
          }
        />
        <GemStatRow
          label={t('gem.backtest.maxDrawdown')}
          value={
            <GemSigned
              value={backtest.maxDrawdownPercent}
              format={(value) => formatSignedPercent(value)}
            />
          }
        />
        <GemStatRow
          label={t('gem.backtest.hitRate')}
          value={
            backtest.hitRatePercent === null ? (
              <GemUnknown />
            ) : (
              formatPercent(backtest.hitRatePercent, 1)
            )
          }
        />
      </dl>
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        {backtest.netOfCosts ? t('gem.backtest.netOfCosts') : t('gem.backtest.grossOfCosts')}
      </p>
      {/* Gaps are held flat, which is a return of zero -- the figures are
          annualised over the priced span so they do not read as though the
          strategy earned nothing there, and this says how much is missing. */}
      {backtest.coveragePercent < 100 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('gem.backtest.partialCoverage', {
            coverage: formatPercent(backtest.coveragePercent, 0),
          })}
        </p>
      )}
    </GemCard>
  );
}
