import { formatDateYMD } from "../../common/date-utils";
import { zonedWallClock } from "./market-session.util";

/**
 * What a security knows about where and when it trades. Every field is
 * nullable because the columns are: `securities.market_timezone` and
 * `market_close_time` stay null until a provider refresh reports a session.
 */
export interface SecurityMarketSession {
  marketTimezone: string | null;
  marketCloseTime: string | null;
}

/**
 * Is the trading session for `priceDate` over, as of `now`?
 *
 * This is the difference between a **provisional** price and a **settled** one,
 * and the two must not be stored as though they were the same fact. A live
 * quote taken at 14:42 is a true statement about 14:42 and a false statement
 * about the day: it is not the close, its volume is a running total, and its
 * high and low are only the extremes reached so far. Writing it into
 * `security_prices` for the day is correct while the session is open and wrong
 * the moment it ends -- which is why the closing job replaces those numbers
 * with the provider's official daily bar rather than leaving whichever quote
 * happened to be fetched last.
 *
 * The comparison is done on the *market's* wall clock, not the server's and not
 * UTC. An exchange closes at a local time that survives daylight saving, so
 * "16:00 America/New_York" is the durable fact and the epoch instant it maps to
 * is not.
 *
 * With no stored session -- a security nothing has quoted yet -- the answer
 * falls back to "only days before today (UTC) are settled". That is
 * deliberately the conservative direction: the cost of calling a finished
 * session unfinished is one day's delay before the official bar lands, and the
 * cost of the opposite is storing a half-day's trading as a closing price.
 */
export function isSessionSettled(
  priceDate: string,
  session: SecurityMarketSession,
  now: Date,
): boolean {
  const { marketTimezone, marketCloseTime } = session;
  if (marketTimezone && marketCloseTime) {
    const local = zonedWallClock(now, marketTimezone);
    if (local) {
      if (priceDate < local.date) return true;
      if (priceDate > local.date) return false;
      // Same calendar day in the market's zone: settled once the clock is at
      // or past the close. Both sides are zero-padded "HH:mm:ss", so a string
      // comparison is a chronological one.
      return local.time >= marketCloseTime;
    }
  }
  return priceDate < formatDateYMD(now);
}
