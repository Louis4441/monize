import { SECURITY_EXCHANGES, SecurityExchange } from "./security-enums";

/**
 * The market indexes the Security Performance report can overlay.
 *
 * A fixed, curated catalog rather than a free-form symbol field. Three reasons,
 * all of which have a defect behind them elsewhere in this codebase:
 *
 * 1. An unvalidated ticker fetches *something* far more often than it fetches
 *    nothing, and a wrong instrument drawn beside a holding is worse than no
 *    line at all.
 * 2. Every code here is refreshed on a schedule for the whole deployment. A
 *    user-typed symbol would become a permanent row nobody owns and nobody
 *    prunes.
 * 3. `code` is the app's own key, so the provider symbol is an implementation
 *    detail. Switching provider, or adding a second one, is a change to this
 *    file rather than a migration over stored data.
 *
 * `exchanges` is what makes an index *relevant* rather than merely available: it
 * lists the `SECURITY_EXCHANGES` codes the index is the natural benchmark for,
 * so the UI can offer a TSX holder the S&P/TSX Composite before the Nikkei. It
 * is a hint for ordering, not a restriction -- comparing a US stock against the
 * Nikkei is a legitimate thing to want.
 *
 * Every entry is an index Yahoo serves as a daily series through the same v8
 * chart endpoint the securities use. Instruments that only some providers carry,
 * or that are quoted irregularly, are deliberately absent: a benchmark that goes
 * missing for a fortnight is worse than one that was never offered, because the
 * chart has already been read against it.
 */
export interface MarketIndexDefinition {
  /** Stable app key. Never the provider's spelling. */
  code: string;
  /** Symbol for the Yahoo v8 chart endpoint. */
  yahooSymbol: string;
  /** English name; the frontend `marketIndexes` catalog localizes it by code. */
  defaultName: string;
  /** The currency the index level is quoted in. */
  currencyCode: string;
  /** Grouping for the picker. */
  region: "NORTH_AMERICA" | "EUROPE" | "ASIA_PACIFIC";
  /** Exchanges this index is the natural benchmark for. */
  exchanges: readonly SecurityExchange[];
}

const NORTH_AMERICAN_US: readonly SecurityExchange[] = [
  "NYSE",
  "NASDAQ",
  "AMEX",
  "ARCA",
  "BATS",
];

const CANADIAN: readonly SecurityExchange[] = ["TSX", "TSX-V", "CSE", "NEO"];

export const MARKET_INDEXES: readonly MarketIndexDefinition[] = [
  {
    code: "SP500",
    yahooSymbol: "^GSPC",
    defaultName: "S&P 500",
    currencyCode: "USD",
    region: "NORTH_AMERICA",
    exchanges: NORTH_AMERICAN_US,
  },
  {
    code: "NASDAQ_COMPOSITE",
    yahooSymbol: "^IXIC",
    defaultName: "NASDAQ Composite",
    currencyCode: "USD",
    region: "NORTH_AMERICA",
    exchanges: ["NASDAQ"],
  },
  {
    code: "DOW_JONES",
    yahooSymbol: "^DJI",
    defaultName: "Dow Jones Industrial Average",
    currencyCode: "USD",
    region: "NORTH_AMERICA",
    exchanges: NORTH_AMERICAN_US,
  },
  {
    code: "RUSSELL_2000",
    yahooSymbol: "^RUT",
    defaultName: "Russell 2000",
    currencyCode: "USD",
    region: "NORTH_AMERICA",
    exchanges: NORTH_AMERICAN_US,
  },
  {
    code: "SP_TSX_COMPOSITE",
    yahooSymbol: "^GSPTSE",
    defaultName: "S&P/TSX Composite",
    currencyCode: "CAD",
    region: "NORTH_AMERICA",
    exchanges: CANADIAN,
  },
  {
    code: "FTSE_100",
    yahooSymbol: "^FTSE",
    defaultName: "FTSE 100",
    currencyCode: "GBP",
    region: "EUROPE",
    exchanges: ["LSE"],
  },
  {
    code: "DAX",
    yahooSymbol: "^GDAXI",
    defaultName: "DAX",
    currencyCode: "EUR",
    region: "EUROPE",
    exchanges: ["XETRA", "Frankfurt"],
  },
  {
    code: "CAC_40",
    yahooSymbol: "^FCHI",
    defaultName: "CAC 40",
    currencyCode: "EUR",
    region: "EUROPE",
    exchanges: ["Paris"],
  },
  {
    code: "AEX",
    yahooSymbol: "^AEX",
    defaultName: "AEX",
    currencyCode: "EUR",
    region: "EUROPE",
    exchanges: ["AMS"],
  },
  {
    code: "FTSE_MIB",
    yahooSymbol: "FTSEMIB.MI",
    defaultName: "FTSE MIB",
    currencyCode: "EUR",
    region: "EUROPE",
    exchanges: ["MIL"],
  },
  {
    code: "OMXS30",
    yahooSymbol: "^OMX",
    defaultName: "OMX Stockholm 30",
    currencyCode: "SEK",
    region: "EUROPE",
    exchanges: ["STO"],
  },
  {
    code: "EURO_STOXX_50",
    yahooSymbol: "^STOXX50E",
    defaultName: "EURO STOXX 50",
    currencyCode: "EUR",
    region: "EUROPE",
    // A pan-European benchmark: relevant to every euro-area listing rather than
    // to one exchange, which is why it names several.
    exchanges: ["XETRA", "Frankfurt", "Paris", "AMS", "MIL"],
  },
  {
    code: "NIKKEI_225",
    yahooSymbol: "^N225",
    defaultName: "Nikkei 225",
    currencyCode: "JPY",
    region: "ASIA_PACIFIC",
    exchanges: ["Tokyo"],
  },
  {
    code: "HANG_SENG",
    yahooSymbol: "^HSI",
    defaultName: "Hang Seng",
    currencyCode: "HKD",
    region: "ASIA_PACIFIC",
    exchanges: ["HKEX"],
  },
  {
    code: "SSE_COMPOSITE",
    yahooSymbol: "000001.SS",
    defaultName: "SSE Composite",
    currencyCode: "CNY",
    region: "ASIA_PACIFIC",
    exchanges: ["SHA"],
  },
  {
    code: "SZSE_COMPONENT",
    yahooSymbol: "399001.SZ",
    defaultName: "SZSE Component",
    currencyCode: "CNY",
    region: "ASIA_PACIFIC",
    exchanges: ["SHE"],
  },
  {
    code: "ASX_200",
    yahooSymbol: "^AXJO",
    defaultName: "S&P/ASX 200",
    currencyCode: "AUD",
    region: "ASIA_PACIFIC",
    exchanges: ["ASX"],
  },
  {
    code: "KOSPI",
    yahooSymbol: "^KS11",
    defaultName: "KOSPI",
    currencyCode: "KRW",
    region: "ASIA_PACIFIC",
    exchanges: ["KRX"],
  },
  {
    code: "TAIEX",
    yahooSymbol: "^TWII",
    defaultName: "TAIEX",
    currencyCode: "TWD",
    region: "ASIA_PACIFIC",
    exchanges: ["TAI"],
  },
  {
    code: "STI",
    yahooSymbol: "^STI",
    defaultName: "Straits Times Index",
    currencyCode: "SGD",
    region: "ASIA_PACIFIC",
    exchanges: ["SGX"],
  },
  {
    code: "SENSEX",
    yahooSymbol: "^BSESN",
    defaultName: "BSE SENSEX",
    currencyCode: "INR",
    region: "ASIA_PACIFIC",
    exchanges: ["BSE"],
  },
  {
    code: "NIFTY_50",
    yahooSymbol: "^NSEI",
    defaultName: "NIFTY 50",
    currencyCode: "INR",
    region: "ASIA_PACIFIC",
    exchanges: ["NSE"],
  },
];

/** Every catalog key, for DTO validation. */
export const MARKET_INDEX_CODES: readonly string[] = MARKET_INDEXES.map(
  (index) => index.code,
);

const BY_CODE = new Map(MARKET_INDEXES.map((index) => [index.code, index]));

/** The definition for a code, or undefined when the code is not in the catalog. */
export function marketIndexByCode(
  code: string,
): MarketIndexDefinition | undefined {
  return BY_CODE.get(code);
}

/** True when every exchange named by the catalog is a canonical one. */
export function catalogExchangesAreCanonical(): boolean {
  const canonical = new Set<string>(SECURITY_EXCHANGES);
  return MARKET_INDEXES.every((index) =>
    index.exchanges.every((exchange) => canonical.has(exchange)),
  );
}
