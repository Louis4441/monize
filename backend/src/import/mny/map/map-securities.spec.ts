import { mnySecurity } from "../__fixtures__/mny-row-builders";
import {
  MAX_SECURITY_SYMBOL_LENGTH,
  mapSecurities,
  placeholderSymbol,
} from "./map-securities";

describe("mapSecurities", () => {
  const base = {
    currencyByHandle: new Map<number, string>([
      [1, "USD"],
      [2, "GBP"],
    ]),
    baseCurrency: "USD",
  };

  it("maps a plain security", () => {
    const result = mapSecurities({
      ...base,
      securities: [
        mnySecurity({
          handle: 7,
          symbol: "VOO",
          name: "Vanguard S&P 500",
          currency: 2,
        }),
      ],
    });

    expect(result.securities).toEqual([
      {
        handle: 7,
        symbol: "VOO",
        moneySymbol: "VOO",
        name: "Vanguard S&P 500",
        currencyCode: "GBP",
        skipPriceUpdates: false,
      },
    ]);
    expect(result.byHandle.get(7)?.symbol).toBe("VOO");
    expect(result.warnings).toHaveLength(0);
  });

  it("falls back to the base currency when the security names none", () => {
    const result = mapSecurities({
      ...base,
      securities: [mnySecurity({ handle: 1, currency: null })],
    });

    expect(result.securities[0].currencyCode).toBe("USD");
    expect(result.warnings).toHaveLength(0);
  });

  it("warns and falls back when the currency handle is not in the file", () => {
    const result = mapSecurities({
      ...base,
      securities: [mnySecurity({ handle: 1, currency: 99 })],
    });

    expect(result.securities[0].currencyCode).toBe("USD");
    expect(result.warnings).toEqual([
      {
        code: "unknownCurrency",
        subject: "Vanguard S&P 500",
        detail: "hcrnc=99",
      },
    ]);
  });

  describe("currency pseudo-securities", () => {
    it("excludes rows whose symbol has Money's currency-quote shape", () => {
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "/GBPUS", name: "British pound" }),
          mnySecurity({ handle: 2, symbol: "VOO" }),
        ],
      });

      expect(result.securities.map((s) => s.handle)).toEqual([2]);
      expect(result.skipped).toBe(1);
    });

    it("excludes rows carrying the currency security type", () => {
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "EUR", securityType: 4 }),
        ],
      });

      expect(result.securities).toHaveLength(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe("symbol collisions", () => {
    // PR #192 upserted on (user_id, symbol), so two funds sharing a ticker
    // became one security with one price history.
    it("suffixes the second security instead of collapsing the two", () => {
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "VOO", name: "Vanguard S&P 500" }),
          mnySecurity({ handle: 2, symbol: "VOO", name: "Other VOO fund" }),
        ],
      });

      expect(result.securities.map((s) => s.symbol)).toEqual(["VOO", "VOO-2"]);
      expect(result.securities).toHaveLength(2);
      expect(result.warnings).toEqual([
        { code: "duplicateSecuritySymbol", subject: "VOO", detail: "VOO-2" },
      ]);
    });

    it("keeps suffixing past the second collision", () => {
      const result = mapSecurities({
        ...base,
        securities: [1, 2, 3, 4].map((handle) =>
          mnySecurity({ handle, symbol: "VOO", name: `Fund ${handle}` }),
        ),
      });

      expect(result.securities.map((s) => s.symbol)).toEqual([
        "VOO",
        "VOO-2",
        "VOO-3",
        "VOO-4",
      ]);
    });

    it("compares case-insensitively, as the app's own uniqueness does", () => {
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "voo" }),
          mnySecurity({ handle: 2, symbol: "VOO" }),
        ],
      });

      expect(result.securities.map((s) => s.symbol)).toEqual(["voo", "VOO-2"]);
    });

    it("trims the stem so a suffixed symbol still fits the column", () => {
      const long = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: long }),
          mnySecurity({ handle: 2, symbol: long }),
        ],
      });

      for (const security of result.securities) {
        expect(security.symbol.length).toBeLessThanOrEqual(
          MAX_SECURITY_SYMBOL_LENGTH,
        );
      }
      expect(result.securities[0].symbol).not.toBe(result.securities[1].symbol);
    });
  });

  describe("empty symbols", () => {
    it("generates a placeholder and disables price updates", () => {
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "  ", name: "Acme Growth Fund" }),
        ],
      });

      expect(result.securities[0]).toMatchObject({
        symbol: "AGF*",
        moneySymbol: "",
        name: "Acme Growth Fund",
        skipPriceUpdates: true,
      });
      expect(result.warnings).toEqual([
        {
          code: "generatedSecuritySymbol",
          subject: "Acme Growth Fund",
          detail: "AGF*",
        },
      ]);
    });

    it("keeps two similarly-named funds apart", () => {
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "", name: "Acme Growth Fund" }),
          mnySecurity({ handle: 2, symbol: "", name: "Acme Growth Fund II" }),
          mnySecurity({ handle: 3, symbol: "", name: "Acme Growth Fund" }),
        ],
      });

      const symbols = result.securities.map((s) => s.symbol);
      expect(new Set(symbols).size).toBe(3);
      expect(symbols[0]).toBe("AGF*");
      expect(symbols[2]).toBe("AGF*-2");
    });

    it("skips a row with neither symbol nor name", () => {
      const result = mapSecurities({
        ...base,
        securities: [mnySecurity({ handle: 1, symbol: "", name: "  " })],
      });

      expect(result.securities).toHaveLength(0);
      expect(result.skipped).toBe(1);
    });
  });

  it("skips a row with no handle: nothing can reference it", () => {
    const result = mapSecurities({
      ...base,
      securities: [mnySecurity({ handle: null })],
    });

    expect(result.securities).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});

describe("placeholderSymbol", () => {
  it("uses the initials of a multi-word name", () => {
    expect(placeholderSymbol("Vanguard Total Stock Market")).toBe("VTSM*");
  });

  it("falls back to the first letters of a one-word name", () => {
    expect(placeholderSymbol("Berkshire")).toBe("BERK*");
  });

  it("survives a name with no usable letters", () => {
    expect(placeholderSymbol("--- ---")).toBe("SEC*");
  });

  it("stays inside the column width", () => {
    const symbol = placeholderSymbol("A B C D E F G H I J K L M N O P Q R S T");
    expect(symbol.length).toBeLessThanOrEqual(MAX_SECURITY_SYMBOL_LENGTH);
  });
});
