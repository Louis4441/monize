'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowTrendingUpIcon,
  BanknotesIcon,
  ChartPieIcon,
  CircleStackIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import {
  SummaryCardGrid,
  type SummaryCardItem,
} from '@/components/accounts/shared/SummaryCardGrid';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { gainLossColor } from '@/lib/format';
import { withCurrencyCode } from '@/lib/security-detail';
import type { SecurityDetail } from '@/types/investment';

interface SecuritySummaryCardsProps {
  detail: SecurityDetail;
  /**
   * The close the market value was struck at, and whether it is recent enough to
   * pass for today's. Null when no price is on record.
   */
  quoteAsOf?: { priceDate: string; isCurrent: boolean } | null;
}

const ICON_CLASS = 'h-4 w-4';

/**
 * The five key figures, all in the security's own currency -- the currency its
 * price and average cost are quoted in, and the only one they add up in without
 * a conversion this page has no business making.
 *
 * A figure the portfolio could not compute is reported as unknown rather than as
 * zero: a zero market value is a claim about worth, and "there is no quote" (or
 * "this sits in a closed account") is not that claim.
 */
export function SecuritySummaryCards({
  detail,
  quoteAsOf = null,
}: SecuritySummaryCardsProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const {
    formatCurrency,
    formatCurrencyPrecise,
    formatQuantity,
    formatPercent,
    formatSignedPercent,
    defaultCurrency,
  } = useNumberFormat();

  const { convertToDefault, getRate } = useExchangeRates();

  const { position, security } = detail;
  const currency = security.currencyCode;
  const isForeign = !!currency && currency !== defaultCurrency;

  /** The figure itself, in the security's own currency, named when foreign. */
  const money = (amount: number) =>
    withCurrencyCode(formatCurrency(amount, currency), currency, defaultCurrency);

  /**
   * The same figure in the reader's own currency, as a second line.
   *
   * At today's rate, which is why it is marked as approximate: for the market
   * value that is exactly right, but a cost basis converted today is not what
   * was paid -- the historical-rate figure for that lives in the Accounts table.
   * All three cards convert at the same rate, so the arithmetic between them
   * still holds.
   */
  // Only when a rate actually exists. `convertToDefault` falls back to the
  // amount unconverted when it has no rate for the pair, which would print a
  // euro figure under a zloty symbol -- a fabricated number, and a worse failure
  // than showing nothing.
  const hasRate = isForeign && getRate(currency, defaultCurrency) !== null;

  const converted = (amount: number | null) => {
    if (!hasRate || amount === null) return undefined;
    const value = convertToDefault(amount, currency);
    if (!isFinite(value)) return undefined;
    return t('cards.approx', {
      amount: formatCurrency(value, defaultCurrency),
    });
  };
  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">
      {t('cards.valueUnknown')}
    </span>
  );

  /** A signed money figure, so colour is never the only signal of a loss. */
  const signedMoney = (amount: number) =>
    `${amount >= 0 ? '+' : ''}${withCurrencyCode(
      formatCurrency(amount, currency),
      currency,
      defaultCurrency,
    )}`;

  const totalUnits = position.quantity;

  const cards: SummaryCardItem[] = [
    {
      label: t('cards.marketValue'),
      icon: <ChartPieIcon className={ICON_CLASS} />,
      value:
        position.marketValue === null
          ? unknown
          : money(position.marketValue),
      // Market value is quantity times the newest close on record, whatever day
      // that is. A security whose prices stopped updating in 2019 would
      // otherwise present a 2019 valuation as today's, with nothing on the card
      // to say so -- the header already flags a stale quote, and this figure is
      // derived from the very same price.
      note: (
        <>
          {converted(position.marketValue) && (
            <div>{converted(position.marketValue)}</div>
          )}
          {position.marketValue !== null &&
            quoteAsOf !== null &&
            (quoteAsOf.isCurrent ? (
              <div>{t('cards.asOf', { date: formatDate(quoteAsOf.priceDate) })}</div>
            ) : (
              <div
                className="text-amber-600 dark:text-amber-500"
                title={t('cards.asOfStaleTitle')}
              >
                {t('cards.asOfStale', { date: formatDate(quoteAsOf.priceDate) })}
              </div>
            ))}
        </>
      ),
    },
    {
      label: t('cards.costBasis'),
      icon: <BanknotesIcon className={ICON_CLASS} />,
      value:
        position.costBasis === null
          ? unknown
          : money(position.costBasis),
      note: converted(position.costBasis),
    },
    {
      label: t('cards.unrealizedPl'),
      icon: <ArrowTrendingUpIcon className={ICON_CLASS} />,
      value:
        position.gainLoss === null ? unknown : signedMoney(position.gainLoss),
      valueClass:
        position.gainLoss === null
          ? undefined
          : gainLossColor(position.gainLoss),
      note: (
        <>
          {position.gainLossPercent !== null && (
            <div className={gainLossColor(position.gainLossPercent)}>
              {formatSignedPercent(position.gainLossPercent)}
            </div>
          )}
          {converted(position.gainLoss) && (
            <div>{converted(position.gainLoss)}</div>
          )}
        </>
      ),
    },
    {
      label: t('cards.units'),
      icon: <CircleStackIcon className={ICON_CLASS} />,
      value: formatQuantity(totalUnits),
      note: (
        <>
          <div>{t('cards.avgCostPerUnit')}</div>
          <div>
            {position.averageCost === null
              ? t('cards.valueUnknown')
              : withCurrencyCode(
                  formatCurrencyPrecise(position.averageCost, currency),
                  currency,
                  defaultCurrency,
                )}
          </div>
        </>
      ),
    },
    {
      label: t('cards.heldInAccounts'),
      icon: <UserGroupIcon className={ICON_CLASS} />,
      // Two units of information per row, so this card carries a small list
      // instead of the single figure the others show.
      className: 'sm:col-span-2',
      value: null,
      body: (
        <div className="mt-1">
          {detail.accounts.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('empty.noAccounts')}
            </p>
          ) : (
            <>
              {/* Bounded and scrolling past a handful of accounts, so a security
                  spread over ten of them leaves this card the same height as one
                  held in a single account -- it sits in a row with five others,
                  and growing it drags the whole grid down. `scrollbar-slim`
                  keeps the bar quiet; the native one is what looked broken. */}
              <ul className="scrollbar-slim max-h-24 space-y-0.5 overflow-y-auto pr-1">
                {detail.accounts.map((account) => (
                  <li
                    key={account.accountId}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span
                      className={`truncate ${
                        account.isClosed
                          ? 'text-gray-500 dark:text-gray-400'
                          : 'text-gray-900 dark:text-gray-100'
                      }`}
                    >
                      {account.isClosed
                        ? t('accounts.closedSuffix', {
                            name: account.accountName,
                          })
                        : account.accountName}
                    </span>
                    <span className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                      {t('cards.unitsShare', {
                        units: formatQuantity(account.quantity),
                        // A share of the total, not a gain: no leading sign.
                        share: formatPercent(
                          totalUnits === 0
                            ? 0
                            : (account.quantity / totalUnits) * 100,
                        ),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-gray-200 pt-1 text-sm font-semibold text-gray-900 dark:border-gray-700 dark:text-gray-100">
                <span>{t('cards.total')}</span>
                <span className="tabular-nums">
                  {formatQuantity(totalUnits)}
                </span>
              </div>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <SummaryCardGrid
      cards={cards}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
    />
  );
}
