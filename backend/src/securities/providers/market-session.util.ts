import { QuoteResult } from "./quote-provider.interface";

/** Where and when an instrument trades, in the market's own local time. */
export interface MarketSession {
  timezone: string;
  /** "HH:mm:ss" local to `timezone`. */
  openTime: string;
  closeTime: string;
}

/** An instant expressed as the wall clock of some zone. */
export interface ZonedWallClock {
  /** Calendar date in the zone, "YYYY-MM-DD". */
  date: string;
  /** Time of day in the zone, "HH:mm:ss". */
  time: string;
}

/**
 * The calendar date and wall-clock time an instant falls on in a given zone.
 *
 * `en-GB` rather than the default locale so the hour is 24-hour and the parts
 * are stable; `hourCycle: "h23"` because `hour12: false` alone still yields
 * "24" for midnight in some engines, which is not a time Postgres accepts.
 *
 * Returns null for a zone the runtime cannot resolve rather than falling back
 * to the server's own zone: a date derived from the wrong place is worse than
 * no date, because nothing downstream can tell the two apart.
 */
export function zonedWallClock(
  instant: Date,
  timezone: string,
): ZonedWallClock | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(instant);
    const at = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value;
    const year = at("year");
    const month = at("month");
    const day = at("day");
    const hour = at("hour");
    const minute = at("minute");
    const second = at("second");
    if (!year || !month || !day || !hour || !minute || !second) return null;
    return {
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}:${second}`,
    };
  } catch {
    // An unknown zone throws rather than falling back, which is the right
    // outcome: a session recorded against a zone we cannot resolve would be
    // read back as a time in the wrong place.
    return null;
  }
}

function localTimeOfDay(epochSeconds: number, timezone: string): string | null {
  return zonedWallClock(new Date(epochSeconds * 1000), timezone)?.time ?? null;
}

/**
 * The calendar day a daily bar belongs to, as UTC midnight.
 *
 * Providers stamp a daily bar with the instant its session opened, which lands
 * on a different date in different zones -- 23:00 UTC is already tomorrow in
 * Sydney. So the day is read in the exchange's own zone where the provider
 * reports one, and in UTC otherwise; never in the server's local zone, which
 * would make the stored `price_date` depend on where the container runs.
 *
 * The result is UTC midnight so `formatDateYMD` (UTC components) and every
 * `toISOString().substring(0, 10)` in the price path yield that same day.
 */
export function barDate(epochSeconds: number, timezone?: string | null): Date {
  const instant = new Date(epochSeconds * 1000);
  const local = timezone ? zonedWallClock(instant, timezone) : null;
  if (local) return new Date(`${local.date}T00:00:00.000Z`);
  const utcMidnight = new Date(instant);
  utcMidnight.setUTCHours(0, 0, 0, 0);
  return utcMidnight;
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
