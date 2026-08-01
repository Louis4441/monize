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
 * Which of the four cost statements the run earns. A configured cost the
 * simulation could not apply -- an absolute commission with no known portfolio
 * total, or anything at all on a truncated run -- is not deducted, and the copy
 * must not say it was.
 */
function costsApplied(backtest: GemBacktestSummary) {
  if (backtest.taxApplied && backtest.commissionApplied) return 'netOfCosts';
  if (backtest.taxApplied) return 'netOfTaxOnly';
  if (backtest.commissionApplied) return 'netOfCommissionOnly';
  return 'grossOfCosts';
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
      {/* Four states, not two: tax is a percentage and always applicable,
          while an absolute commission needs a known portfolio total to become
          a drag -- so "net of taxes and commissions" was being printed over
          figures no commission had come off. */}
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        {t(`gem.backtest.${costsApplied(backtest)}`)}
      </p>
      {/* Below 100 the run is the most recent unbroken stretch of priced
          periods and everything before the last gap is outside it, so the
          window the figures describe is shorter than the strategy's history.
          The server also reports such a run gross, which is why the line above
          can say "excludes taxes and commissions" on a configuration that
          sets both. */}
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
