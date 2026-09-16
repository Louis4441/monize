import {
  attachInvestmentRowCurrencies,
  investmentRowCurrencies,
} from "./investment-transaction-currencies.util";

describe("investmentRowCurrencies", () => {
  it("denominates price, commission and total in the security's currency", () => {
    expect(
      investmentRowCurrencies({
        security: { currencyCode: "EUR" },
        account: { currencyCode: "PLN" },
        fundingAccount: null,
      }),
    ).toEqual({
      amountCurrencyCode: "EUR",
      priceCurrencyCode: "EUR",
      commissionCurrencyCode: "EUR",
      settlementCurrencyCode: "PLN",
    });
  });

  it("takes the settlement currency from the funding account when one is named", () => {
    const codes = investmentRowCurrencies({
      security: { currencyCode: "USD" },
      account: { currencyCode: "PLN" },
      fundingAccount: { currencyCode: "EUR" },
    });
    expect(codes.settlementCurrencyCode).toBe("EUR");
    expect(codes.amountCurrencyCode).toBe("USD");
  });

  it("reports an unknown amount currency rather than the account's when no security is named", () => {
    // The regression: falling back to the account here is what printed a
    // foreign trade with the reader's own symbol.
    expect(
      investmentRowCurrencies({
        security: null,
        account: { currencyCode: "PLN" },
      }),
    ).toEqual({
      amountCurrencyCode: null,
      priceCurrencyCode: null,
      commissionCurrencyCode: null,
      settlementCurrencyCode: "PLN",
    });
  });

  it("reports an unknown settlement currency when neither account is loaded", () => {
    expect(
      investmentRowCurrencies({ security: { currencyCode: "GBP" } })
        .settlementCurrencyCode,
    ).toBeNull();
  });

  it("stamps every row of a page", () => {
    const rows = [
      { security: { currencyCode: "EUR" }, account: { currencyCode: "PLN" } },
      { security: { currencyCode: "USD" }, account: { currencyCode: "PLN" } },
    ];
    attachInvestmentRowCurrencies(rows);
    expect(
      rows.map(
        (r) => (r as { amountCurrencyCode?: string }).amountCurrencyCode,
      ),
    ).toEqual(["EUR", "USD"]);
  });
});
