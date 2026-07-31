import { MappedSecurities } from "../model/mny-import-model";
import { mnySecurity } from "../__fixtures__/mny-row-builders";
import {
  MAX_SECURITY_SYMBOL_LENGTH,
  MapSecuritiesInput,
  mapSecurities,
  placeholderSymbol,
  stripMarketPrefix,
} from "./map-securities";

/**
 * Every security the case hands in counts as held, so a test about symbols or
 * currencies is not also a test about the activity filter. The cases that care
 * about that filter call `mapSecurities` directly.
 */
function mapHeld(
  input: Omit<MapSecuritiesInput, "activeHandles">,
): MappedSecurities {
  return mapSecurities({
    ...input,
    activeHandles: new Set(
      input.securities
        .map((security) => security.handle)
        .filter((handle): handle is number => handle !== null),
    ),
  });
}

describe("mapSecurities", () => {
  const base = {
    currencyByHandle: new Map<number, string>([
      [1, "USD"],
      [2, "GBP"],
    ]),
    baseCurrency: "USD",
  };

  it("maps a plain security", () => {
    const result = mapHeld({
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
    const result = mapHeld({
      ...base,
      securities: [mnySecurity({ handle: 1, currency: null })],
    });

    expect(result.securities[0].currencyCode).toBe("USD");
    expect(result.warnings).toHaveLength(0);
  });

  it("warns and falls back when the currency handle is not in the file", () => {
    const result = mapHeld({
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

  describe("the activity filter", () => {
    // Money's SEC doubles as its watch list and its index-quote store. In the
    // maintainer's file 31 of 98 securities appear in no TRN row and no LOT,
    // and they carry 17,025 of the 69,076 prices -- the Dow, the NASDAQ, the
    // DAX, the FTSE, the Nikkei and the TSX among them, under the same `sct`
    // as two ETFs actually owned. Only activity separates the two.
    it("keeps a security the user transacted in", () => {
      const result = mapSecurities({
        ...base,
        securities: [mnySecurity({ handle: 7, symbol: "VOO" })],
        activeHandles: new Set([7]),
      });

      expect(result.securities.map((s) => s.handle)).toEqual([7]);
      expect(result.skipped).toBe(0);
    });

    it("drops a security with no transaction and no lot", () => {
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 7, symbol: "VOO" }),
          mnySecurity({ handle: 8, symbol: "$INDU", name: "Dow Jones" }),
        ],
        activeHandles: new Set([7]),
      });

      expect(result.securities.map((s) => s.handle)).toEqual([7]);
      expect(result.skipped).toBe(1);
      // Nothing to warn about: the user never held it.
      expect(result.warnings).toEqual([]);
    });

    it("does not spend a symbol on a security it drops", () => {
      // The dropped row must not push the held one onto `VOO-2`, which would
      // leave the user's real holding under a symbol no quote provider knows.
      const result = mapSecurities({
        ...base,
        securities: [
          mnySecurity({ handle: 8, symbol: "VOO", name: "Watched" }),
          mnySecurity({ handle: 7, symbol: "VOO", name: "Held" }),
        ],
        activeHandles: new Set([7]),
      });

      expect(result.securities.map((s) => s.symbol)).toEqual(["VOO"]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe("currency pseudo-securities", () => {
    it("excludes rows whose symbol has Money's currency-quote shape", () => {
      const result = mapHeld({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "/GBPUS", name: "British pound" }),
          mnySecurity({ handle: 2, symbol: "VOO" }),
        ],
      });

      expect(result.securities.map((s) => s.handle)).toEqual([2]);
      expect(result.skipped).toBe(1);
    });

    // `sct` 4 was read as "currency" and is Money's money-market fund. It
    // skipped the security, and with it every transaction pointing at it: 829
    // in the maintainer's file, reported as missingInvestmentDetail.
    it("imports a money-market fund, which is what the sct 4 code means", () => {
      const result = mapHeld({
        ...base,
        securities: [
          mnySecurity({
            handle: 1,
            symbol: "TDB164",
            name: "TD Canadian Money Market",
            securityType: 4,
          }),
        ],
      });

      expect(result.securities.map((s) => s.symbol)).toEqual(["TDB164"]);
      expect(result.skipped).toBe(0);
    });

    it("excludes a currency by symbol shape whatever its security type", () => {
      const result = mapHeld({
        ...base,
        securities: [
          mnySecurity({ handle: 1, symbol: "/EURUS", securityType: 6 }),
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
      const result = mapHeld({
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
      const result = mapHeld({
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
      const result = mapHeld({
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
      const result = mapHeld({
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
      const result = mapHeld({
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
      const result = mapHeld({
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
      const result = mapHeld({
        ...base,
        securities: [mnySecurity({ handle: 1, symbol: "", name: "  " })],
      });

      expect(result.securities).toHaveLength(0);
      expect(result.skipped).toBe(1);
    });
  });

  it("skips a row with no handle: nothing can reference it", () => {
    const result = mapHeld({
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

describe("stripMarketPrefix", () => {
  // Money qualifies a symbol with the market it trades on. Real Money Plus
  // files hold both shapes side by side: `US:VTI` for a holding and
  // `$US:INDU`, `$DE:DAX` for an index, where `$` is Money's index marker.
  it("removes the market a holding trades on", () => {
    expect(stripMarketPrefix("US:VTI")).toBe("VTI");
    expect(stripMarketPrefix("US:GLDM")).toBe("GLDM");
  });

  it("keeps an index an index, dropping only the market", () => {
    expect(stripMarketPrefix("$US:INDU")).toBe("$INDU");
    expect(stripMarketPrefix("$DE:DAX")).toBe("$DAX");
    expect(stripMarketPrefix("$JP:NI225")).toBe("$NI225");
  });

  it("leaves a symbol Money never qualified alone", () => {
    expect(stripMarketPrefix("XIU")).toBe("XIU");
    expect(stripMarketPrefix("$OSPTX")).toBe("$OSPTX");
    expect(stripMarketPrefix("BMO146")).toBe("BMO146");
    // A currency pseudo-security, which must survive to be recognised as one.
    expect(stripMarketPrefix("/GBPUS")).toBe("/GBPUS");
  });

  it("does not treat a longer prefix as a market", () => {
    expect(stripMarketPrefix("NYSE:VTI")).toBe("NYSE:VTI");
  });

  it("keeps what Money stored when stripping would leave nothing", () => {
    expect(stripMarketPrefix("US:")).toBe("US:");
    expect(stripMarketPrefix("$US:")).toBe("$US:");
  });
});

describe("mapSecurities market prefixes", () => {
  const base = {
    currencyByHandle: new Map<number, string>([[1, "USD"]]),
    baseCurrency: "USD",
  };

  it("imports a qualified symbol under its bare ticker", () => {
    // The defect this guards: `writeSecurities` matches existing holdings by
    // symbol, so an imported `US:VTI` sat beside the user's own `VTI` as a
    // second security and asked the quote providers for a symbol that does
    // not exist.
    const result = mapHeld({
      ...base,
      securities: [
        mnySecurity({ handle: 1, symbol: "US:VTI", name: "Vanguard" }),
      ],
    });

    expect(result.securities[0].symbol).toBe("VTI");
    // The file's own spelling is still recorded.
    expect(result.securities[0].moneySymbol).toBe("US:VTI");
  });

  it("suffixes rather than merges when stripping collides", () => {
    const result = mapHeld({
      ...base,
      securities: [
        mnySecurity({ handle: 1, symbol: "VTI", name: "Held directly" }),
        mnySecurity({ handle: 2, symbol: "US:VTI", name: "Held in the US" }),
      ],
    });

    expect(result.securities.map((s) => s.symbol)).toEqual(["VTI", "VTI-2"]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "duplicateSecuritySymbol" }),
    );
  });
});
