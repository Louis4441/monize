/**
 * The currency each money field on an investment transaction is denominated in.
 *
 * `price`, `commission` and `total_amount` are stored in the **security's**
 * currency (`docs/financial-semantics.md` section 6: `total_amount` is
 * `quantity * price +/- commission`, and `computeInvestmentCashImpact` derives
 * the cash side from the same three before any conversion). The row's
 * `exchangeRate` then converts that amount into the *settlement* account's
 * currency -- the funding account when one is named, otherwise the brokerage
 * account the row is filed under.
 *
 * Deriving a row's currency from the account it is filed under is what made a
 * EUR trade and a USD trade both print with the reader's own symbol
 * (issue #1394). A row with no security has no security currency, and that is
 * `null` -- unknown, rendered as unknown -- never the account's and never the
 * reader's.
 */
export interface InvestmentRowCurrencies {
  /** Currency of `totalAmount`; `null` when the row names no security. */
  amountCurrencyCode: string | null;
  /** Currency of `price`; the security's, like the amount. */
  priceCurrencyCode: string | null;
  /** Currency of `commission`; the security's, being part of `totalAmount`. */
  commissionCurrencyCode: string | null;
  /** Currency the row's cash leg settles in, or `null` when neither is loaded. */
  settlementCurrencyCode: string | null;
}

/** The relations `investmentRowCurrencies` reads, as much of them as it needs. */
export interface InvestmentRowCurrencySource {
  security?: { currencyCode?: string | null } | null;
  account?: { currencyCode?: string | null } | null;
  fundingAccount?: { currencyCode?: string | null } | null;
}

/**
 * Derive the four currency codes for one row. Every consumer reads these
 * instead of guessing from an account, so the unit travels with the figure.
 */
export function investmentRowCurrencies(
  row: InvestmentRowCurrencySource,
): InvestmentRowCurrencies {
  const securityCurrency = row.security?.currencyCode || null;
  const settlement =
    row.fundingAccount?.currencyCode || row.account?.currencyCode || null;
  return {
    amountCurrencyCode: securityCurrency,
    priceCurrencyCode: securityCurrency,
    commissionCurrencyCode: securityCurrency,
    settlementCurrencyCode: settlement,
  };
}

/**
 * Stamp the codes onto every row of a page before it leaves the service.
 *
 * Mutates in place, as `attachAccruedInterest` does beside it: these are the
 * loaded entity instances the controller serialises, and rebuilding them would
 * drop the relations the same response carries.
 */
export function attachInvestmentRowCurrencies<
  T extends InvestmentRowCurrencySource & Partial<InvestmentRowCurrencies>,
>(rows: readonly T[]): void {
  for (const row of rows) {
    Object.assign(row, investmentRowCurrencies(row));
  }
}
