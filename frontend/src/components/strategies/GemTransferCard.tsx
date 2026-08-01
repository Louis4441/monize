'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { GemAction } from '@/types/gem-strategy';
import { isKnown } from '@/lib/gem-strategy-view';
import {
  GemAccountLinks,
  GemCard,
  GemEmptyState,
  GemSigned,
  GemStatRow,
  GemUnknown,
} from './GemPrimitives';

interface GemTransferCardProps {
  action: GemAction | null;
  /** True when the report has no signal yet, so there is nothing to compare against. */
  signalUnavailable?: boolean;
  /** True when the strategy has no account, so there is no portfolio to move. */
  noAccount?: boolean;
}

/**
 * The money side of the pending operation: how much moves, what it realizes, and
 * out of which account. Costs (tax, commission) are only rendered when the
 * server estimated them.
 */
export function GemTransferCard({
  action,
  signalUnavailable = false,
  noAccount = false,
}: GemTransferCardProps) {
  const t = useTranslations('strategies');
  const { formatCurrency } = useNumberFormat();

  if (!action || !action.required) {
    return (
      <GemCard title={t('gem.transfer.title')} hint={t('gem.transfer.hint')}>
        <GemEmptyState
          title={
            noAccount && !signalUnavailable
              ? t('gem.portfolio.noAccountTitle')
              : t('gem.transfer.noneTitle')
          }
          description={
            // Without a signal there is no target to compare the account with,
            // so the "already holds the target" reason would be wrong.
            // "The strategy accounts already hold the target instrument" is a
            // claim about accounts that do not exist. The portfolio card says
            // the same thing on the same row; this card must not contradict it.
            signalUnavailable
              ? t('gem.transfer.noSignalDescription')
              : noAccount
                ? t('gem.portfolio.noAccountDescription')
                : t('gem.transfer.noneDescription')
          }
        />
      </GemCard>
    );
  }

  const currency = action.currencyCode;

  return (
    <GemCard title={t('gem.transfer.title')} hint={t('gem.transfer.hint')}>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('gem.transfer.valueLabel')}
      </p>
      <p className="text-xl font-semibold text-gray-900 dark:text-gray-100">
        {isKnown(action.transferValue) ? (
          formatCurrency(action.transferValue, currency)
        ) : (
          <GemUnknown label={t('gem.transfer.valueUnknown')} />
        )}
      </p>

      {/* Compliance can be well above zero while the whole position still
          moves: a fund's on-target sleeve cannot be kept without keeping the
          rest of it, so the sale is all or nothing. */}
      {action.partialMatchCount > 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('gem.transfer.partialMatchNote', {
            count: action.partialMatchCount,
          })}
        </p>
      )}

      <dl className="mt-3 space-y-1">
        <GemStatRow
          label={t('gem.transfer.realized')}
          value={
            <GemSigned
              value={action.realizedGainLoss}
              format={(value) =>
                `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value), currency)}`
              }
            />
          }
        />
        {isKnown(action.estimatedTax) && (
          <GemStatRow
            label={
              isKnown(action.taxRatePercent)
                ? t('gem.transfer.taxWithRate', { rate: action.taxRatePercent })
                : t('gem.transfer.tax')
            }
            value={formatCurrency(action.estimatedTax, currency)}
          />
        )}
        {isKnown(action.estimatedCommission) && (
          <GemStatRow
            label={t('gem.transfer.commissionForTrades', {
              trades: action.estimatedTradeCount,
            })}
            value={formatCurrency(action.estimatedCommission, currency)}
          />
        )}
        <GemStatRow
          label={t('gem.transfer.accounts')}
          value={
            action.accounts.length > 0 ? (
              <GemAccountLinks accounts={action.accounts} />
            ) : (
              <GemUnknown />
            )
          }
        />
      </dl>
    </GemCard>
  );
}
