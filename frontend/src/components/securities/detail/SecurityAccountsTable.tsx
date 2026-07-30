'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { withCurrencyCode } from '@/lib/security-detail';
import type { SecurityDetail } from '@/types/investment';

interface SecurityAccountsTableProps {
  detail: SecurityDetail;
}

const TH =
  'px-3 py-2 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const TD = 'px-3 py-2 text-sm whitespace-nowrap';

/**
 * The position broken down by account.
 *
 * Money is in the security's own currency throughout, so a row and the Total
 * below it are in the same unit and genuinely add up. Cost basis additionally
 * shows the account's currency underneath where the two differ -- that figure
 * comes from the portfolio's historical-rate conversion, so it matches the
 * Portfolio page rather than being converted again here.
 *
 * Following the app's other tables, narrow screens hide the least important
 * columns and scroll the rest rather than reflowing into cards.
 */
export function SecurityAccountsTable({ detail }: SecurityAccountsTableProps) {
  const t = useTranslations('securityDetail');
  const {
    formatCurrency,
    formatCurrencyPrecise,
    formatQuantity,
    formatSignedPercent,
    defaultCurrency,
  } = useNumberFormat();
  const { accounts, position, security } = detail;
  const currency = security.currencyCode;

  if (accounts.length === 0) return null;

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">
      {t('cards.valueUnknown')}
    </span>
  );

  /**
   * Money in the security's currency, or the unknown marker. Carries the code
   * when that is not the reader's own currency: nothing on this page is
   * converted, and a symbol alone does not say which dollar it is.
   */
  const money = (amount: number | null): ReactNode =>
    amount === null
      ? unknown
      : withCurrencyCode(
          formatCurrency(amount, currency),
          currency,
          defaultCurrency,
        );

  /** A signed gain with its percentage under it, coloured and signed. */
  const gain = (amount: number | null, percent: number | null): ReactNode => {
    if (amount === null) return unknown;
    return (
      <span className={gainLossColor(amount)}>
        {amount >= 0 ? '+' : ''}
        {withCurrencyCode(
          formatCurrency(amount, currency),
          currency,
          defaultCurrency,
        )}
        {percent !== null && (
          <div className="text-xs font-normal">
            {formatSignedPercent(percent)}
          </div>
        )}
      </span>
    );
  };

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('accounts.title')}
      </h3>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className={`${TH} text-left`}>
                {t('accounts.columns.account')}
              </th>
              <th
                scope="col"
                className={`${TH} hidden text-left sm:table-cell`}
              >
                {t('accounts.columns.currency')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('accounts.columns.units')}
              </th>
              <th
                scope="col"
                className={`${TH} hidden text-right lg:table-cell`}
              >
                {t('accounts.columns.avgCost')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('accounts.columns.marketValue')}
              </th>
              <th
                scope="col"
                className={`${TH} hidden text-right md:table-cell`}
              >
                {t('accounts.columns.costBasis')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('accounts.columns.unrealizedPl')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {accounts.map((account) => {
              // Only worth a second line when the account is denominated in
              // something other than the security's own currency.
              const showAccountCurrency =
                account.accountCurrencyCode !== null &&
                account.accountCurrencyCode !== currency &&
                account.costBasisAccountCurrency !== null;
              return (
                <tr
                  key={account.accountId}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                    account.isClosed ? 'opacity-60' : ''
                  }`}
                >
                  <td className={`${TD} text-gray-900 dark:text-gray-100`}>
                    {account.isClosed
                      ? t('accounts.closedSuffix', { name: account.accountName })
                      : account.accountName}
                  </td>
                  <td
                    className={`${TD} hidden text-gray-500 dark:text-gray-400 sm:table-cell`}
                  >
                    {account.accountCurrencyCode ?? '-'}
                  </td>
                  <td
                    className={`${TD} text-right tabular-nums text-gray-900 dark:text-gray-100`}
                  >
                    {formatQuantity(account.quantity)}
                  </td>
                  <td
                    className={`${TD} hidden text-right tabular-nums text-gray-700 dark:text-gray-300 lg:table-cell`}
                  >
                    {account.averageCost === null
                      ? unknown
                      : formatCurrencyPrecise(account.averageCost, currency)}
                  </td>
                  <td
                    className={`${TD} text-right tabular-nums text-gray-900 dark:text-gray-100`}
                  >
                    {money(account.marketValue)}
                  </td>
                  <td
                    className={`${TD} hidden text-right tabular-nums text-gray-700 dark:text-gray-300 md:table-cell`}
                  >
                    {money(account.costBasis)}
                    {showAccountCurrency && (
                      <div className="text-xs font-normal text-gray-500 dark:text-gray-400">
                        {formatCurrency(
                          account.costBasisAccountCurrency as number,
                          account.accountCurrencyCode as string,
                        )}
                      </div>
                    )}
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {gain(account.gainLoss, account.gainLossPercent)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50">
            <tr className="font-semibold text-gray-900 dark:text-gray-100">
              <td className={TD}>{t('accounts.total')}</td>
              <td className={`${TD} hidden sm:table-cell`}>{currency}</td>
              <td className={`${TD} text-right tabular-nums`}>
                {formatQuantity(position.quantity)}
              </td>
              <td className={`${TD} hidden lg:table-cell`} />
              <td className={`${TD} text-right tabular-nums`}>
                {money(position.marketValue)}
              </td>
              <td
                className={`${TD} hidden text-right tabular-nums md:table-cell`}
              >
                {money(position.costBasis)}
              </td>
              <td className={`${TD} text-right tabular-nums`}>
                {gain(position.gainLoss, position.gainLossPercent)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
