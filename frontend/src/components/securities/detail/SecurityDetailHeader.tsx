'use client';

import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ClockIcon, StarIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import { Button } from '@/components/ui/Button';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { withCurrencyCode } from '@/lib/security-detail';
import { gainLossColor } from '@/lib/format';
import type { Security } from '@/types/investment';
import { SecuritySwitcher } from './SecuritySwitcher';

/** The latest quote and how far it moved on the day it was quoted. */
export interface SecurityQuote {
  price: number;
  /** ISO date of the price row the quote comes from. */
  priceDate: string;
  /** Change against the previous close; null when there is no earlier price. */
  change: number | null;
  changePercent: number | null;
  /**
   * True when the newest price is recent enough for its move to be "today's".
   * A week-old close still has a delta against the close before it, but calling
   * that today's move would misdate it.
   */
  isCurrent: boolean;
}

interface SecurityDetailHeaderProps {
  security: Security;
  quote: SecurityQuote | null;
  onBack: () => void;
  onEdit: () => void;
  onToggleFavourite: () => void;
  isFavouritePending: boolean;
  /** Active securities the caret beside the name can jump to. */
  securities: readonly Security[];
  onSelectSecurity: (id: string) => void;
}

/**
 * The identity block: which security this is, and what it is worth right now.
 *
 * Deliberately short. Symbol, type, exchange, currency, sector, industry and
 * provider all live in the Key information card a few hundred pixels below, and
 * repeating them here cost a third of the header's height to say the same thing
 * twice. What is left is the name (with a caret to switch securities), the two
 * actions, and the quote.
 */
export function SecurityDetailHeader({
  security,
  quote,
  onBack,
  onEdit,
  onToggleFavourite,
  isFavouritePending,
  securities,
  onSelectSecurity,
}: SecurityDetailHeaderProps) {
  const t = useTranslations('securityDetail');
  const ts = useTranslations('securities');
  const { formatDate } = useDateFormat();
  const { formatCurrencyPrecise, formatSignedPercent, defaultCurrency } =
    useNumberFormat();

  const FavouriteIcon = security.isFavourite ? StarSolidIcon : StarIcon;
  const favouriteLabel = security.isFavourite
    ? ts('list.favouriteButton.remove')
    : ts('list.favouriteButton.add');

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {t('backToSecurities')}
      </button>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-1">
            <h1 className="truncate text-2xl font-bold text-gray-900 dark:text-gray-100">
              {security.name}
            </h1>
            {/* Jump straight to another security instead of going back to the
                list and picking Details again. */}
            <SecuritySwitcher
              currentId={security.id}
              securities={securities}
              onSelect={onSelectSecurity}
            />
          </div>

          {!security.isActive && (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
              {t('header.inactiveBadge')}
            </span>
          )}

          {/* Both actions stay inline at every width: there are only two, and an
              overflow menu whose items jumped the page to a tab further down
              read as the page moving under the user. */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleFavourite}
              isLoading={isFavouritePending}
              aria-pressed={security.isFavourite}
              // The star carries the state visually; the accessible name keeps
              // the wording the securities list already uses for this action.
              aria-label={favouriteLabel}
              title={favouriteLabel}
              className="inline-flex items-center gap-1.5"
            >
              <FavouriteIcon
                className={`h-4 w-4 ${security.isFavourite ? 'text-yellow-500' : ''}`}
                aria-hidden="true"
              />
              {t('header.favourites')}
            </Button>
            <Button variant="outline" size="sm" onClick={onEdit}>
              {t('header.edit')}
            </Button>
          </div>
        </div>

        {/* The quote: legible, but a step below the name in weight, so the page
            still says what this is before what it costs. */}
        <div className="shrink-0 lg:text-right">
          {quote ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 lg:justify-end">
                <span className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {/* The quote is the largest figure on the page and the one a
                      reader anchors on, so it names its currency too when that
                      is not their own. */}
                  {withCurrencyCode(
                    formatCurrencyPrecise(quote.price, security.currencyCode),
                    security.currencyCode,
                    defaultCurrency,
                  )}
                </span>
                {quote.change !== null && quote.changePercent !== null && (
                  <span
                    className={`text-sm font-medium ${gainLossColor(quote.change)}`}
                  >
                    {t(
                      // A stale quote's delta is still the last move, but it did
                      // not happen today, so it is not labelled as if it had.
                      quote.isCurrent
                        ? 'header.changeToday'
                        : 'header.changeLast',
                      {
                        // Explicitly signed: the colour alone must never be the
                        // only thing telling a gain from a loss.
                        change: `${quote.change >= 0 ? '+' : ''}${formatCurrencyPrecise(
                          quote.change,
                          security.currencyCode,
                        )}`,
                        percent: formatSignedPercent(quote.changePercent),
                      },
                    )}
                  </span>
                )}
              </div>
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                <ClockIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {t('header.priceAt', { date: formatDate(quote.priceDate) })}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('header.noPrice')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
