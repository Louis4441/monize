import { Logger } from "@nestjs/common";
import { YahooFinanceService } from "../../securities/yahoo-finance.service";
import {
  HistoricalPrice,
  QuoteResult,
} from "../../securities/providers/quote-provider.interface";
import { FX_FETCH_CONCURRENCY, YahooFxProvider } from "./yahoo-fx.provider";

jest.mock("../../common/date-utils", () => ({
  ...jest.requireActual("../../common/date-utils"),
  todayYMD: jest.fn(() => "2026-10-07"),
}));

const TODAY = "2026-10-07";

/** A chart-endpoint quote as `fetchQuoteRaw` builds it; `price` undefined is a 200 without a price. */
const quoteOf = (symbol: string, price: number | undefined): QuoteResult => ({
  symbol,
  regularMarketPrice: price,
  provider: "yahoo",
});

/** One daily bar as `fetchHistoricalWindow` returns it, dated at UTC midnight. */
const bar = (date: string, close: number): HistoricalPrice => ({
  date: new Date(`${date}T00:00:00.000Z`),
  open: null,
  high: null,
  low: null,
  close,
  adjClose: null,
  volume: null,
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("YahooFxProvider", () => {
  let yahoo: jest.Mocked<
    Pick<YahooFinanceService, "fetchQuote" | "fetchHistoricalWindow">
  >;
  let provider: YahooFxProvider;
  let warn: jest.SpyInstance;

  /** Answer each symbol from a table; an absent symbol is Yahoo returning null. */
  const quotes = (table: Record<string, QuoteResult | null>) => {
    yahoo.fetchQuote.mockImplementation(
      async (symbol: string) => table[symbol] ?? null,
    );
  };
  const windows = (table: Record<string, HistoricalPrice[] | null>) => {
    yahoo.fetchHistoricalWindow.mockImplementation(
      async (symbol: string) => table[symbol] ?? null,
    );
  };
  const askedSymbols = () => yahoo.fetchQuote.mock.calls.map((c) => c[0]);
  const askedWindows = () =>
    yahoo.fetchHistoricalWindow.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    yahoo = {
      fetchQuote: jest.fn().mockResolvedValue(null),
      fetchHistoricalWindow: jest.fn().mockResolvedValue(null),
    };
    provider = new YahooFxProvider(yahoo as unknown as YahooFinanceService);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("is the yahoo provider writing yahoo_finance rows, and carries every code", async () => {
    expect(provider.name).toBe("yahoo");
    expect(provider.source).toBe("yahoo_finance");
    expect(await provider.carries("USD")).toBe(true);
    expect(await provider.carries("XYZ")).toBe(true);
  });

  describe("fetchLatest", () => {
    it("asks the direct symbol and dates the quote today, one call for a quote of 1 or more", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4253) });

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(askedSymbols()).toEqual(["USDCAD=X"]);
      expect(found).not.toBeNull();
      expect(found!.get("CAD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4253,
      });
    });

    it("a quote below 1 is checked against the reverse symbol, and the reverse answer comes back in its own orientation", async () => {
      quotes({
        "CADUSD=X": quoteOf("CADUSD=X", 0.7016),
        "USDCAD=X": quoteOf("USDCAD=X", 1.4253),
      });

      const found = await provider.fetchLatest("CAD", ["USD"]);

      expect(askedSymbols()).toEqual(["CADUSD=X", "USDCAD=X"]);
      expect(found!.get("USD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4253,
      });
    });

    it("a direct symbol Yahoo does not answer is followed by the reverse symbol", async () => {
      quotes({ "CADUSD=X": quoteOf("CADUSD=X", 0.7016) });

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(askedSymbols()).toEqual(["USDCAD=X", "CADUSD=X"]);
      expect(found!.get("CAD")).toEqual({
        from: "CAD",
        to: "USD",
        date: TODAY,
        rate: 0.7016,
      });
    });

    it("a null from fetchQuote never becomes an observation: the quote is absent while the batch is answered", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4253) });

      const found = await provider.fetchLatest("USD", ["CAD", "XYZ"]);

      expect(found).not.toBeNull();
      expect(found!.has("XYZ")).toBe(false);
      expect(found!.size).toBe(1);
    });

    it("a batch no symbol answered is no answer, not an empty map", async () => {
      quotes({});

      expect(await provider.fetchLatest("USD", ["CAD", "EUR"])).toBeNull();
      expect(askedSymbols()).toEqual(
        expect.arrayContaining([
          "USDCAD=X",
          "CADUSD=X",
          "USDEUR=X",
          "EURUSD=X",
        ]),
      );
    });

    it("a 200 without a price is an answer: the quote is absent and the batch is answered", async () => {
      quotes({
        "USDCAD=X": quoteOf("USDCAD=X", undefined),
        "CADUSD=X": quoteOf("CADUSD=X", undefined),
      });

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(found).not.toBeNull();
      expect(found!.size).toBe(0);
    });

    it("a pair too coarse in both orientations is absent, and named in the log", async () => {
      quotes({
        "IDRSGD=X": quoteOf("IDRSGD=X", 0.0001),
        "SGDIDR=X": quoteOf("SGDIDR=X", 0.0),
      });

      const found = await provider.fetchLatest("IDR", ["SGD"]);

      expect(found).not.toBeNull();
      expect(found!.has("SGD")).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("IDR/SGD"));
    });

    it("an empty quote list asks nothing and answers an empty map", async () => {
      const found = await provider.fetchLatest("USD", []);

      expect(found).toEqual(new Map());
      expect(yahoo.fetchQuote).not.toHaveBeenCalled();
    });

    it(`keeps at most ${FX_FETCH_CONCURRENCY} quote fetches in flight`, async () => {
      const codes = Array.from(
        { length: FX_FETCH_CONCURRENCY + 4 },
        (_, i) => `C${String(i).padStart(2, "0")}`,
      );
      let inFlight = 0;
      let peak = 0;
      const release: Array<() => void> = [];
      yahoo.fetchQuote.mockImplementation(
        (symbol: string) =>
          new Promise<QuoteResult | null>((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            release.push(() => {
              inFlight -= 1;
              resolve(quoteOf(symbol, 1.5));
            });
          }),
      );

      const pending = provider.fetchLatest("USD", codes);
      await flush();
      expect(inFlight).toBe(FX_FETCH_CONCURRENCY);
      while (release.length > 0) {
        release.shift()!();
        await flush();
      }
      const found = await pending;

      expect(peak).toBe(FX_FETCH_CONCURRENCY);
      expect(found!.size).toBe(codes.length);
    });
  });

  describe("fetchDailySeries", () => {
    const START = "2024-01-01";
    const END = "2024-01-05";
    const DIRECT = [
      bar("2024-01-02", 1.3294),
      bar("2024-01-03", 1.3347),
      bar("2024-01-04", 1.3332),
      bar("2024-01-05", 1.3369),
    ];

    it("asks the direct symbol over the window and answers observations dated by their bar", async () => {
      windows({ "USDCAD=X": DIRECT });

      const series = await provider.fetchDailySeries("USD", "CAD", START, END);

      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(1);
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledWith(
        "USDCAD=X",
        null,
        new Date("2024-01-01T00:00:00.000Z"),
        new Date("2024-01-05T23:59:59.999Z"),
      );
      expect(series).toEqual([
        { from: "USD", to: "CAD", date: "2024-01-02", rate: 1.3294 },
        { from: "USD", to: "CAD", date: "2024-01-03", rate: 1.3347 },
        { from: "USD", to: "CAD", date: "2024-01-04", rate: 1.3332 },
        { from: "USD", to: "CAD", date: "2024-01-05", rate: 1.3369 },
      ]);
    });

    it("a sparse direct answer is completed by the reverse symbol, densest first, in each one's orientation", async () => {
      const wide = { start: "2024-01-01", end: "2024-01-31" };
      windows({
        "USDCAD=X": [bar("2024-01-02", 1.3294), bar("2024-01-10", 1.33)],
        "CADUSD=X": [
          bar("2024-01-02", 0.7522),
          bar("2024-01-05", 0.75),
          bar("2024-01-15", 0.751),
        ],
      });

      const series = await provider.fetchDailySeries(
        "USD",
        "CAD",
        wide.start,
        wide.end,
      );

      expect(askedWindows()).toEqual(["USDCAD=X", "CADUSD=X"]);
      expect(series).toEqual([
        { from: "CAD", to: "USD", date: "2024-01-02", rate: 0.7522 },
        { from: "CAD", to: "USD", date: "2024-01-05", rate: 0.75 },
        { from: "CAD", to: "USD", date: "2024-01-15", rate: 0.751 },
        { from: "USD", to: "CAD", date: "2024-01-10", rate: 1.33 },
      ]);
    });

    it("the direct answer stays first on a tie in density", async () => {
      const wide = { start: "2024-01-01", end: "2024-01-31" };
      windows({
        "USDCAD=X": [bar("2024-01-02", 1.3294)],
        "CADUSD=X": [bar("2024-01-03", 0.7522)],
      });

      const series = await provider.fetchDailySeries(
        "USD",
        "CAD",
        wide.start,
        wide.end,
      );

      expect(series).toEqual([
        { from: "USD", to: "CAD", date: "2024-01-02", rate: 1.3294 },
        { from: "CAD", to: "USD", date: "2024-01-03", rate: 0.7522 },
      ]);
    });

    it("a direct symbol Yahoo does not answer is answered by the reverse one", async () => {
      windows({
        "CADUSD=X": [bar("2024-01-02", 0.7522), bar("2024-01-03", 0.7492)],
      });

      const series = await provider.fetchDailySeries("USD", "CAD", START, END);

      expect(askedWindows()).toEqual(["USDCAD=X", "CADUSD=X"]);
      expect(series).toEqual([
        { from: "CAD", to: "USD", date: "2024-01-02", rate: 0.7522 },
        { from: "CAD", to: "USD", date: "2024-01-03", rate: 0.7492 },
      ]);
    });

    it("both symbols answering nothing is an empty window, answered", async () => {
      windows({ "USDCAD=X": [], "CADUSD=X": [] });

      expect(await provider.fetchDailySeries("USD", "CAD", START, END)).toEqual(
        [],
      );
    });

    it.each([
      ["direct silent, reverse empty", { "CADUSD=X": [] }],
      ["direct empty, reverse silent", { "USDCAD=X": [] }],
      ["neither answers", {}],
    ])(
      "nothing found while a symbol did not answer is no answer: %s",
      async (_label, table) => {
        windows(table as Record<string, HistoricalPrice[] | null>);

        expect(
          await provider.fetchDailySeries("USD", "CAD", START, END),
        ).toBeNull();
        expect(askedWindows()).toEqual(["USDCAD=X", "CADUSD=X"]);
      },
    );

    it("drops a bar outside the window and a bar without a usable close", async () => {
      windows({
        "USDCAD=X": [
          bar("2023-12-29", 1.3251),
          bar("2024-01-02", 1.3294),
          bar("2024-01-03", 0),
          bar("2024-01-04", Number.NaN),
          bar("2024-01-05", 1.3369),
          bar("2024-01-06", 1.34),
        ],
      });

      const series = await provider.fetchDailySeries("USD", "CAD", START, END);

      expect(series?.map((p) => p.date)).toEqual(["2024-01-02", "2024-01-05"]);
    });
  });

  describe("fetchLive", () => {
    it("is the direct quote dated today when it is 1 or more", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4261) });

      expect(await provider.fetchLive("USD", "CAD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4261,
      });
      expect(askedSymbols()).toEqual(["USDCAD=X"]);
    });

    it("answers the reverse quote in its own orientation when the direct one is silent", async () => {
      quotes({ "USDCAD=X": quoteOf("USDCAD=X", 1.4261) });

      expect(await provider.fetchLive("CAD", "USD")).toEqual({
        from: "USD",
        to: "CAD",
        date: TODAY,
        rate: 1.4261,
      });
      expect(askedSymbols()).toEqual(["CADUSD=X", "USDCAD=X"]);
    });

    it("is null when neither symbol answers", async () => {
      quotes({});

      expect(await provider.fetchLive("USD", "CAD")).toBeNull();
    });
  });
});
