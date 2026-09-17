import type { InvestmentTransaction } from '@/types/investment';

/**
 * The unit each money field on an investment row is in, asked of the row
 * itself rather than inferred at the surface.
 *
 * `price`, `commission` and `totalAmount` are stored in the SECURITY's
 * currency, so taking the label from the account it is filed under is what
 * printed a EUR trade and a USD trade with the same symbol (issue #1394). A row
 * that names no security is the other case and is not unknown: the server
 * denominates it in the investment account's currency when it writes it, and
 * stamps that on the row (`investmentRowCurrencies` on the backend).
 *
 * So the server's stamp is the answer, and `security.currencyCode` -- the same
 * fact from the same row -- is the only accepted fallback, for a backend that
 * predates the stamped fields. `null` is unknown and renders as unknown; the
 * reader's own currency is never the answer.
 */
export function rowAmountCurrency(tx: InvestmentTransaction): string | null {
  return tx.amountCurrencyCode ?? tx.security?.currencyCode ?? null;
}

export function rowPriceCurrency(tx: InvestmentTransaction): string | null {
  return tx.priceCurrencyCode ?? tx.security?.currencyCode ?? null;
}

export function rowCommissionCurrency(tx: InvestmentTransaction): string | null {
  return tx.commissionCurrencyCode ?? tx.security?.currencyCode ?? null;
}
