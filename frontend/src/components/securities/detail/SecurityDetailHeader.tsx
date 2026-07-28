'use client';

import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ClockIcon, StarIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import { Button } from '@/components/ui/Button';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import type { Security } from '@/types/investment';

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
  onToggleWatch: () => void;
  isWatchPending: boolean;
  /** Secondary actions; collapsed into one menu so the row stays short. */
  menuItems: readonly ActionMenuItem[];
}

/**
 * The identity block: what the security is, then what it is worth.
 *
 * Not built on `PageHeader` (as the account detail shell is) because this header
 * carries five distinct lines -- name, classification, tags, provider, quote --
 * where that component takes a single string subtitle. The type scale and
 * colours are lifted from it so the two headers still read as the same header.
 */
export function SecurityDetailHeader({
  security,
  quote,
  onBack,
  onEdit,
  onToggleWatch,
  isWatchPending,
  menuItems,
}: SecurityDetailHeaderProps) {
  const t = useTranslations('securityDetail');
  const ts = useTranslations('securities');
  const { formatDate } = useDateFormat();
  const { formatCurrencyPrecise, formatSignedPercent } = useNumberFormat();

  const typeLabel = security.securityType
    ? ts(`typeLabels.${security.securityType}` as Parameters<typeof ts>[0])
    : null;

  // Symbol first, then the classification that qualifies it. Nulls drop out so
  // a security with no exchange does not render a dangling separator.
  const metaParts = [
    security.symbol,
    typeLabel,
    security.exchange,
    security.currencyCode,
  ].filter((part): part is string => !!part);

  const providerLabel = security.quoteProvider
    ? ts(
        `form.providers.${security.quoteProvider}` as Parameters<typeof ts>[0],
      )
    : null;

  const classification = [security.sector, security.industry].filter(
    (part): part is string => !!part,
  );

  const WatchIcon = security.isFavourite ? StarSolidIcon : StarIcon;

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

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {security.name}
            </h1>
            {!security.isActive && (
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                {t('header.inactiveBadge')}
              </span>
            )}
            {/* The two primary actions stay inline next to the name on every
                width; everything else lives in the menu beside them. */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onToggleWatch}
                isLoading={isWatchPending}
                aria-pressed={security.isFavourite}
                className="inline-flex items-center gap-1.5"
              >
                <WatchIcon className="h-4 w-4" aria-hidden="true" />
                {security.isFavourite
                  ? t('header.watching')
                  : t('header.watch')}
              </Button>
              <Button variant="outline" size="sm" onClick={onEdit}>
                {t('header.edit')}
              </Button>
              {menuItems.length > 0 && (
                <ActionMenu
                  label={t('header.moreActions')}
                  items={menuItems}
                  className="!w-auto"
                />
              )}
            </div>
          </div>

          <p className="mt-1 text-gray-500 dark:text-gray-400">
            {metaParts.join(t('header.metaSeparator'))}
          </p>

          {classification.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {classification.map((part) => (
                <span
                  key={part}
                  className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                >
                  {part}
                </span>
              ))}
            </div>
          )}

          {security.tags && security.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {security.tags.map((tag) => (
                // Same chip the securities list draws, including its fallback
                // grey for a tag the user never assigned a colour.
                <span
                  key={tag.id}
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: tag.color ? `${tag.color}20` : '#9ca3af20',
                    color: tag.color || '#6b7280',
                  }}
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}

          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {providerLabel
              ? t('header.provider', { provider: providerLabel })
              : t('header.providerNotSet')}
          </p>
        </div>

        {/* The quote: present and legible, but a step below the name in weight,
            so the page still says what this is before what it costs. */}
        <div className="shrink-0 lg:text-right">
          {quote ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 lg:justify-end">
                <span className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {formatCurrencyPrecise(quote.price, security.currencyCode)}
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
