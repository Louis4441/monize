'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
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
 * Money is shown in each account's own currency -- that is the figure on the
 * holder's statement -- with the security's quote currency underneath where the
 * two differ. Following the app's other tables, narrow screens hide the least
 * important columns and scroll the rest rather than reflowing into cards.
 */
export function SecurityAccountsTable({ detail }: SecurityAccountsTableProps) {
  const t = useTranslations('securityDetail');
  const { formatCurrency, formatCurrencyPrecise, formatQuantity, formatSignedPercent } =
    useNumberFormat();
  const { accounts, position, security, defaultCurrency } = detail;

  if (accounts.length === 0) return null;

  const showSecondary = (accountCurrency: string) =>
    accountCurrency !== security.currencyCode;

  // The footer reports the backend's own aggregate rather than re-adding the
  // rows: those are in whatever currency each account uses, and the totals have
  // already been converted to the reporting currency once, correctly.
  const totalUnits = position.quantity;

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
            {accounts.map((account) => (
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
                  {account.accountCurrencyCode}
                </td>
                <td
                  className={`${TD} text-right tabular-nums text-gray-900 dark:text-gray-100`}
                >
                  {formatQuantity(account.quantity)}
                </td>
                <td
                  className={`${TD} hidden text-right tabular-nums text-gray-700 dark:text-gray-300 lg:table-cell`}
                >
                  {formatCurrencyPrecise(
                    account.averageCost,
                    security.currencyCode,
                  )}
                </td>
                <td
                  className={`${TD} text-right tabular-nums text-gray-900 dark:text-gray-100`}
                >
                  {account.marketValueAccountCurrency === null ? (
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('cards.valueUnknown')}
                    </span>
                  ) : (
                    <>
                      {formatCurrency(
                        account.marketValueAccountCurrency,
                        account.accountCurrencyCode,
                      )}
                      {showSecondary(account.accountCurrencyCode) &&
                        account.marketValue !== null && (
                          <div className="text-xs font-normal text-gray-500 dark:text-gray-400">
                            {formatCurrency(
                              account.marketValue,
                              security.currencyCode,
                            )}
                          </div>
                        )}
                    </>
                  )}
                </td>
                <td
                  className={`${TD} hidden text-right tabular-nums text-gray-700 dark:text-gray-300 md:table-cell`}
                >
                  {formatCurrency(
                    account.costBasisAccountCurrency,
                    account.accountCurrencyCode,
                  )}
                  {showSecondary(account.accountCurrencyCode) && (
                    <div className="text-xs font-normal text-gray-500 dark:text-gray-400">
                      {formatCurrency(account.costBasis, security.currencyCode)}
                    </div>
                  )}
                </td>
                <td className={`${TD} text-right tabular-nums`}>
                  {account.gainLossAccountCurrency === null ? (
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('cards.valueUnknown')}
                    </span>
                  ) : (
                    <span
                      className={gainLossColor(account.gainLossAccountCurrency)}
                    >
                      {account.gainLossAccountCurrency >= 0 ? '+' : ''}
                      {formatCurrency(
                        account.gainLossAccountCurrency,
                        account.accountCurrencyCode,
                      )}
                      {account.gainLossPercent !== null && (
                        <div className="text-xs font-normal">
                          {formatSignedPercent(account.gainLossPercent)}
                        </div>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50">
            <tr className="font-semibold text-gray-900 dark:text-gray-100">
              <td className={TD}>{t('accounts.total')}</td>
              <td className={`${TD} hidden sm:table-cell`}>
                {defaultCurrency}
              </td>
              <td className={`${TD} text-right tabular-nums`}>
                {formatQuantity(totalUnits)}
              </td>
              <td className={`${TD} hidden lg:table-cell`} />
              <td className={`${TD} text-right tabular-nums`}>
                {position.marketValueDefaultCurrency === null
                  ? t('cards.valueUnknown')
                  : formatCurrency(
                      position.marketValueDefaultCurrency,
                      defaultCurrency,
                    )}
              </td>
              <td
                className={`${TD} hidden text-right tabular-nums md:table-cell`}
              >
                {formatCurrency(
                  position.costBasisDefaultCurrency,
                  defaultCurrency,
                )}
              </td>
              <td className={`${TD} text-right tabular-nums`}>
                {position.gainLossDefaultCurrency === null ? (
                  t('cards.valueUnknown')
                ) : (
                  <span
                    className={gainLossColor(position.gainLossDefaultCurrency)}
                  >
                    {position.gainLossDefaultCurrency >= 0 ? '+' : ''}
                    {formatCurrency(
                      position.gainLossDefaultCurrency,
                      defaultCurrency,
                    )}
                  </span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
