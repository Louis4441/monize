'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { GemPosition } from '@/types/gem-strategy';
import { compliancePercent, isKnown } from '@/lib/gem-strategy-view';
import {
  GemAccountLinks,
  GemBadge,
  GemCard,
  GemEmptyState,
  GemSecurityLink,
  GemStatRow,
  GemUnknown,
} from './GemPrimitives';
import { useGemLabels } from './useGemLabels';

interface GemPortfolioPanelProps {
  position: GemPosition | null;
  noAccount: boolean;
  noPosition: boolean;
}

/**
 * "My portfolio" tab: every instrument the strategy accounts hold, valued and
 * marked against the signal, plus the compliance figure the overview summarizes.
 * The whole portfolio is listed because that is what the strategy compares
 * against -- an instrument it never assigned still has to be moved.
 */
export function GemPortfolioPanel({ position, noAccount, noPosition }: GemPortfolioPanelProps) {
  const t = useTranslations('strategies');
  const { assetFullLabel, dimensionLabel } = useGemLabels();
  const { formatCurrency, formatQuantity, formatPercent } = useNumberFormat();

  if (!position || noAccount) {
    return (
      <GemCard title={t('gem.portfolioPanel.title')}>
        <GemEmptyState
          title={t('gem.portfolio.noAccountTitle')}
          description={t('gem.portfolio.noAccountDescription')}
        />
      </GemCard>
    );
  }

  const percent = compliancePercent(position.compliancePercent);
  const targetSecurityId = position.target?.securityId ?? null;


  return (
    <GemCard title={t('gem.portfolioPanel.title')} hint={t('gem.portfolio.hint')}>
      <dl className="space-y-1">
        <GemStatRow
          label={t('gem.portfolioPanel.accounts')}
          value={
            position.accounts.length > 0 ? (
              <GemAccountLinks accounts={position.accounts} />
            ) : (
              <GemUnknown />
            )
          }
        />
        <GemStatRow
          label={t('gem.portfolio.target')}
          value={
            position.target?.securityId ? (
              <GemSecurityLink securityId={position.target.securityId}>
                {assetFullLabel(position.target)}
              </GemSecurityLink>
            ) : (
              <GemUnknown />
            )
          }
        />
        <GemStatRow
          label={t('gem.portfolio.compliance')}
          value={percent === null ? <GemUnknown /> : formatPercent(percent, 0)}
        />
        <GemStatRow
          label={t('gem.portfolio.changeRequired')}
          value={
            <GemBadge tone={position.changeRequired ? 'red' : 'green'}>
              {position.changeRequired ? t('gem.common.yes') : t('gem.common.no')}
            </GemBadge>
          }
        />
        <GemStatRow
          label={t('gem.portfolioPanel.totalValue')}
          value={
            isKnown(position.totalMarketValue) ? (
              formatCurrency(position.totalMarketValue, position.currencyCode)
            ) : (
              <GemUnknown />
            )
          }
        />
      </dl>

      {noPosition || position.holdings.length === 0 ? (
        <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <GemEmptyState
            title={t('gem.portfolio.noPositionTitle')}
            description={t('gem.portfolioPanel.noPositionHint')}
          />
        </div>
      ) : (
        <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('gem.portfolioPanel.holdings', { count: position.holdings.length })}
          </h4>
          <ul className="space-y-1">
            {position.holdings.map((holding) => {
              const isTarget =
                targetSecurityId !== null && holding.securityId === targetSecurityId;
              // A partial match is worth naming: it is the part that stays put.
              const partial =
                !isTarget &&
                isKnown(holding.matchPercent) &&
                holding.matchPercent > 0 &&
                holding.matchPercent < 100;
              return (
                <li
                  key={holding.securityId ?? holding.symbol}
                  className="flex items-start justify-between gap-3 text-sm"
                >
                  <span className="flex min-w-0 items-start gap-1.5">
                    <span className="min-w-0">
                      <span className="block text-gray-900 dark:text-gray-100">
                        <GemSecurityLink
                          securityId={holding.securityId}
                          className="break-words"
                        >
                          {assetFullLabel(holding)}
                        </GemSecurityLink>
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {isKnown(holding.quantity)
                          ? t('gem.action.units', {
                              units: formatQuantity(holding.quantity),
                            })
                          : t('gem.common.unknown')}
                        {isTarget && (
                          <>
                            <span aria-hidden="true"> &middot; </span>
                            {t('gem.portfolioPanel.isTarget')}
                          </>
                        )}
                        {partial && (
                          <>
                            <span aria-hidden="true"> &middot; </span>
                            {t('gem.portfolioPanel.partialMatch', {
                              percent: formatPercent(holding.matchPercent as number, 0),
                            })}
                          </>
                        )}
                        {!holding.role && (
                          <>
                            <span aria-hidden="true"> &middot; </span>
                            {t('gem.portfolioPanel.notInStrategy')}
                          </>
                        )}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                    {isKnown(holding.marketValue) ? (
                      formatCurrency(holding.marketValue, position.currencyCode)
                    ) : (
                      <GemUnknown />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t('gem.portfolioPanel.holdingsHint')}
          </p>
          {isKnown(position.totalMarketValue) && position.target && (
            <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('gem.portfolioPanel.workingTitle')}
              </h4>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400">
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t('gem.portfolioPanel.workingInstrument')}
                      </th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">
                        {t('gem.portfolioPanel.workingValue')}
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t('gem.portfolioPanel.workingMatch')}
                      </th>
                      <th scope="col" className="py-1 text-right font-medium">
                        {t('gem.portfolioPanel.workingCounts')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                    {position.holdings.map((holding) => {
                      const isTargetRow =
                        targetSecurityId !== null &&
                        holding.securityId === targetSecurityId;
                      const share = isKnown(holding.matchPercent)
                        ? holding.matchPercent / 100
                        : 0;
                      const counted = isKnown(holding.marketValue)
                        ? holding.marketValue * share
                        : null;
                      return (
                        <tr key={holding.securityId ?? holding.symbol}>
                          <td className="py-1 pr-3">
                            <GemSecurityLink securityId={holding.securityId}>
                              {holding.symbol ?? t('gem.common.unassigned')}
                            </GemSecurityLink>
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {isKnown(holding.marketValue) ? (
                              formatCurrency(holding.marketValue, position.currencyCode)
                            ) : (
                              <GemUnknown />
                            )}
                          </td>
                          <td className="py-1 pr-3">
                            {/* The markets that actually overlap, named. A bare
                                percentage says a fifth is on target; this says
                                which fifth, so the figure can be checked. */}
                            {position.basis === 'INSTRUMENT'
                              ? isTargetRow
                                ? t('gem.portfolioPanel.workingExact')
                                : t('gem.portfolioPanel.workingNoTargetData')
                              : isTargetRow
                              ? t('gem.portfolioPanel.workingExact')
                              : holding.matchedMarkets.length > 0
                                ? t('gem.portfolioPanel.workingDerived', {
                                    markets: holding.matchedMarkets
                                      .map((market) =>
                                        t('gem.portfolioPanel.workingMarket', {
                                          name: market.name,
                                          percent: formatPercent(
                                            market.percent,
                                            0,
                                          ),
                                        }),
                                      )
                                      .join(', '),
                                  })
                                : holding.matchedByInstrument
                                  ? t('gem.portfolioPanel.workingByInstrument')
                                  : t('gem.portfolioPanel.workingNoOverlap')}
                          </td>
                          <td className="py-1 text-right tabular-nums">
                            {counted === null ? (
                              <GemUnknown />
                            ) : (
                              formatCurrency(counted, position.currencyCode)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-200 font-medium dark:border-gray-700">
                      <td className="py-1 pr-3">
                        {t('gem.portfolioPanel.workingTotal')}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {formatCurrency(
                          position.totalMarketValue,
                          position.currencyCode,
                        )}
                      </td>
                      <td className="py-1 pr-3" />
                      <td className="py-1 text-right tabular-nums">
                        {percent === null ? (
                          <GemUnknown />
                        ) : (
                          formatCurrency(
                            (position.totalMarketValue * percent) / 100,
                            position.currencyCode,
                          )
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {/* A derived percentage is not the same thing as holding the
                  target fund: it is what the recorded breakdown implies. */}
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t('gem.portfolioPanel.workingDerivedNote')}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {percent === null
                  ? t('gem.portfolioPanel.workingUnknown')
                  : t('gem.portfolioPanel.workingSum', {
                      counted: formatCurrency(
                        (position.totalMarketValue * percent) / 100,
                        position.currencyCode,
                      ),
                      total: formatCurrency(
                        position.totalMarketValue,
                        position.currencyCode,
                      ),
                      percent: formatPercent(percent, 0),
                    })}
              </p>
            </div>
          )}

          {/* Which comparison produced the compliance figure. Matching by
              ticker is the weaker answer, so the report says when it had to. */}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {position.basis === 'COMPOSITION'
              ? t('gem.portfolioPanel.basisComposition', {
                  dimension: dimensionLabel(position.dimension),
                })
              : t('gem.portfolioPanel.basisInstrument', {
                  dimension: dimensionLabel(position.requiredDimension),
                  target: position.target?.symbol ?? t('gem.common.unassigned'),
                })}
            {position.basis === 'COMPOSITION' &&
              position.instrumentMatchedCount > 0 && (
                <>
                  {' '}
                  {t('gem.portfolioPanel.basisPartialData', {
                    count: position.instrumentMatchedCount,
                  })}
                </>
              )}
          </p>
        </div>
      )}
    </GemCard>
  );
}
