import { QuoteResult } from "./quote-provider.interface";

/** Where and when an instrument trades, in the market's own local time. */
export interface MarketSession {
  timezone: string;
  /** "HH:mm:ss" local to `timezone`. */
  openTime: string;
  closeTime: string;
}

/**
 * The wall-clock time an instant falls on in a given zone, as "HH:mm:ss".
 *
 * `en-GB` rather than the default locale so the hour is 24-hour and the parts
 * are stable; `hourCycle: "h23"` because `hour12: false` alone still yields
 * "24" for midnight in some engines, which is not a time Postgres accepts.
 */
function localTimeOfDay(epochSeconds: number, timezone: string): string | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(new Date(epochSeconds * 1000));
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    const second = parts.find((p) => p.type === "second")?.value;
    if (!hour || !minute || !second) return null;
    return `${hour}:${minute}:${second}`;
  } catch {
    // An unknown zone throws rather than falling back, which is the right
    // outcome: a session recorded against a zone we cannot resolve would be
    // read back as a time in the wrong place.
    return null;
  }
}

/**
 * Read a quote's regular trading session as local opening and closing times.
 *
 * The provider reports the window for the specific day the quote came from, so
 * a half day gives a genuine early close. Storing it as a local time of day
 * rather than as the instants themselves is what makes it reusable tomorrow:
 * the epochs expire, "the NYSE opens at 09:30 New York time" does not.
 *
 * Returns null unless both the zone and the window are present and usable --
 * a session without its zone cannot be compared against any clock.
 */
export function getMarketSessionFromQuote(
  quote: QuoteResult,
): MarketSession | null {
  const timezone = quote.exchangeTimezone;
  const session = quote.regularSession;
  if (!timezone || !session) return null;
  if (!Number.isFinite(session.start) || !Number.isFinite(session.end)) {
    return null;
  }

  const openTime = localTimeOfDay(session.start, timezone);
  const closeTime = localTimeOfDay(session.end, timezone);
  if (!openTime || !closeTime) return null;
  // A zero-length or inverted window is not a session; better to keep the last
  // good one than to record a market that is never open.
  if (openTime >= closeTime) return null;

  return { timezone, openTime, closeTime };
}
