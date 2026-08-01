'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { GemPosition } from '@/types/gem-strategy';
import { compliancePercent } from '@/lib/gem-strategy-view';
import {
  GemBadge,
  GemCard,
  GemEmptyState,
  GemSecurityLink,
  GemStatRow,
  GemUnknown,
} from './GemPrimitives';
import { useGemLabels } from './useGemLabels';

interface GemPortfolioCardProps {
  position: GemPosition | null;
  /** True when no account is assigned to the strategy. */
  noAccount: boolean;
}

/**
 * Question 3 of the report: does the real portfolio match the strategy? Shows the
 * held instrument against the target one and how much of the strategy account is
 * already positioned per the signal.
 */
export function GemPortfolioCard({ position, noAccount }: GemPortfolioCardProps) {
  const t = useTranslations('strategies');
  const { assetFullLabel } = useGemLabels();
  const { formatPercent } = useNumberFormat();

  if (!position || noAccount) {
    return (
      <GemCard title={t('gem.portfolio.title')} hint={t('gem.portfolio.hint')}>
        <GemEmptyState
          title={t('gem.portfolio.noAccountTitle')}
          description={t('gem.portfolio.noAccountDescription')}
        />
      </GemCard>
    );
  }

  const percent = compliancePercent(position.compliancePercent);

  return (
    <GemCard title={t('gem.portfolio.title')} hint={t('gem.portfolio.hint')}>
      <dl className="space-y-1">
        <GemStatRow
          label={t('gem.portfolio.current')}
          value={
            position.current ? (
              <span>
                <GemSecurityLink securityId={position.current.securityId}>
                  {assetFullLabel(position.current)}
                </GemSecurityLink>
                {/* The largest holding names the position, but the count says
                    the accounts hold more than that one instrument. */}
                {position.holdings.length > 1 &&
                  ` +${position.holdings.length - 1}`}
              </span>
            ) : (
              <GemUnknown label={t('gem.portfolio.noPositionTitle')} />
            )
          }
        />
        <GemStatRow
          label={t('gem.portfolio.target')}
          value={
            position.target ? (
              <GemSecurityLink securityId={position.target.securityId}>
                {assetFullLabel(position.target)}
              </GemSecurityLink>
            ) : (
              <GemUnknown />
            )
          }
        />
      </dl>

      <div className="mt-3">
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">
            {t('gem.portfolio.compliance')}
          </span>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {percent === null ? <GemUnknown /> : formatPercent(percent, 0)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={t('gem.portfolio.compliance')}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent === null ? {} : { 'aria-valuenow': percent })}
          className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
        >
          {/* One neutral fill: the percentage above and the "change required"
              badge below already say whether this is good or bad. */}
          <div
            className="h-full rounded-full bg-gray-400 dark:bg-gray-500"
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-gray-500 dark:text-gray-400">
          {t('gem.portfolio.changeRequired')}
        </span>
        <GemBadge tone={position.changeRequired ? 'red' : 'green'}>
          {position.changeRequired ? t('gem.common.yes') : t('gem.common.no')}
        </GemBadge>
      </div>
    </GemCard>
  );
}
