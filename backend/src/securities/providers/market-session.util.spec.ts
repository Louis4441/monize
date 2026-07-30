import { getMarketSessionFromQuote } from "./market-session.util";
import { QuoteResult } from "./quote-provider.interface";

/** Thursday 2026-07-30, NYSE regular session, as the provider reports it. */
const NYSE_OPEN = Math.floor(Date.parse("2026-07-30T13:30:00Z") / 1000);
const NYSE_CLOSE = Math.floor(Date.parse("2026-07-30T20:00:00Z") / 1000);

function quote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    symbol: "AAPL",
    exchangeTimezone: "America/New_York",
    regularSession: { start: NYSE_OPEN, end: NYSE_CLOSE },
    ...overrides,
  };
}

describe("getMarketSessionFromQuote", () => {
  it("converts the session to the exchange's own local clock", () => {
    // The epochs are UTC; stored as local times they stay right tomorrow, and
    // across a daylight-saving change, which fixed offsets would not.
    expect(getMarketSessionFromQuote(quote())).toEqual({
      timezone: "America/New_York",
      openTime: "09:30:00",
      closeTime: "16:00:00",
    });
  });

  it("keeps a half day as the early close the provider reported", () => {
    const earlyClose = Math.floor(Date.parse("2026-07-30T17:00:00Z") / 1000);
    expect(
      getMarketSessionFromQuote(
        quote({ regularSession: { start: NYSE_OPEN, end: earlyClose } }),
      ),
    ).toMatchObject({ openTime: "09:30:00", closeTime: "13:00:00" });
  });

  it("reads a market in another part of the world in its own time", () => {
    const open = Math.floor(Date.parse("2026-07-30T07:00:00Z") / 1000);
    const close = Math.floor(Date.parse("2026-07-30T15:30:00Z") / 1000);
    expect(
      getMarketSessionFromQuote(
        quote({
          exchangeTimezone: "Europe/London",
          regularSession: { start: open, end: close },
        }),
      ),
    ).toEqual({
      timezone: "Europe/London",
      openTime: "08:00:00",
      closeTime: "16:30:00",
    });
  });

  it("returns null without a timezone, since a session alone cannot be read", () => {
    expect(
      getMarketSessionFromQuote(quote({ exchangeTimezone: null })),
    ).toBeNull();
  });

  it("returns null without a session window", () => {
    expect(
      getMarketSessionFromQuote(quote({ regularSession: null })),
    ).toBeNull();
  });

  it("returns null for a timezone it cannot resolve", () => {
    expect(
      getMarketSessionFromQuote(
        quote({ exchangeTimezone: "Mars/Olympus_Mons" }),
      ),
    ).toBeNull();
  });

  it("rejects a window that is empty or inverted", () => {
    // Keeping the previous good session beats recording a market that is
    // never open.
    expect(
      getMarketSessionFromQuote(
        quote({ regularSession: { start: NYSE_CLOSE, end: NYSE_OPEN } }),
      ),
    ).toBeNull();
    expect(
      getMarketSessionFromQuote(
        quote({ regularSession: { start: NYSE_OPEN, end: NYSE_OPEN } }),
      ),
    ).toBeNull();
  });

  it("rejects a non-finite window rather than storing NaN times", () => {
    expect(
      getMarketSessionFromQuote(
        quote({ regularSession: { start: Number.NaN, end: NYSE_CLOSE } }),
      ),
    ).toBeNull();
  });
});
