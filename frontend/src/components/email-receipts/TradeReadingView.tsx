'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { fromReceiptUnits } from '@/lib/email-receipts-format';
import type { ParsedTrade } from '@/types/email-receipts';

interface TradeReadingViewProps {
  trade: ParsedTrade;
  /** The day to show when the email states none: the day it arrived (or the shop's day for a forward), an ISO timestamp; null when unknown. */
  fallbackDate: string | null;
  /**
   * Say why an incomplete reading is incomplete. The detail dialog does not
   * need it (its status line says so); the profile test panel has no status line.
   */
  showReason?: boolean;
}

/**
 * What a profile with a `trade` section read from a brokerage confirmation: one
 * sentence naming the direction, the shares, the ticker and the executed total,
 * the account text the email printed and, when the average price does not fit the
 * shares and the total, why the trade will wait for a person.
 *
 * The total is in the security's currency, which the email does not name, so it
 * is shown as a plain number unless the email named its currency; the review
 * card shows it with the security's. An incomplete reading names its reason only
 * when asked (`showReason`): in the detail dialog the status line above does.
 */
export function TradeReadingView({ trade, fallbackDate, showReason = false }: TradeReadingViewProps) {
  const t = useTranslations('emailReceipts.trade');
  const tReason = useTranslations('emailReceipts.detail.reasons');
  const { formatCurrency, formatNumber, formatShareQuantity } = useNumberFormat();
  const money = (units: number, decimals: number) =>
    trade.currency
      ? formatCurrency(fromReceiptUnits(units), trade.currency)
      : formatNumber(fromReceiptUnits(units), decimals);
  const { formatDate } = useDateFormat();

  const tradeDate = trade.date ?? fallbackDate;

  if (!trade.complete || trade.action === null || trade.symbol === null || trade.quantity === null) {
    const reasonKey = trade.reason;
    return (
      <div className="space-y-1 text-sm text-gray-500 dark:text-gray-400">
        <p>{t('incomplete')}</p>
        {showReason && reasonKey && tReason.has(reasonKey) && <p>{tReason(reasonKey)}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
      <p className="font-medium text-gray-900 dark:text-gray-100">
        {t('summary', {
          action: trade.action,
          quantity: formatShareQuantity(trade.quantity),
          symbol: trade.symbol,
          // A trade read from its price alone has no stated total: the figure is then the price's.
          total: trade.total === null ? t('totalFromPrice') : money(trade.total, 2),
          date: tradeDate === null ? t('dateUnknown') : formatDate(tradeDate),
        })}
      </p>
      {trade.price !== null && <p>{t('price', { price: money(trade.price, 4) })}</p>}
      {trade.accountText && <p>{t('account', { account: trade.accountText })}</p>}
      {trade.consistent === false && (
        <p role="note" className="text-amber-800 dark:text-amber-300">
          {t('priceMismatch')}
        </p>
      )}
    </div>
  );
}
