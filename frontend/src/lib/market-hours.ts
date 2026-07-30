/**
 * Is a security's market trading right now?
 *
 * The session comes from the quote provider and is stored against the
 * exchange's own IANA zone, so this answers the question live rather than as of
 * the last price refresh, and daylight saving is handled by the zone rather
 * than by a stored offset that goes wrong twice a year.
 */

/** What the market is doing, or that we cannot say. */
export type MarketState = 'open' | 'closed' | 'unknown';

export interface MarketSession {
  /** IANA zone, e.g. "America/New_York". */
  timezone?: string | null;
  /** "HH:mm:ss" local to `timezone`. */
  openTime?: string | null;
  closeTime?: string | null;
}

/** Weekday index (0 = Sunday) and "HH:mm:ss", both in `timezone`. */
function localParts(
  timezone: string,
  now: Date,
): { weekday: number; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);

    const find = (type: string) => parts.find((p) => p.type === type)?.value;
    const weekdayName = find('weekday');
    const hour = find('hour');
    const minute = find('minute');
    const second = find('second');
    if (!weekdayName || !hour || !minute || !second) return null;

    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      weekdayName,
    );
    if (weekday === -1) return null;

    return { weekday, time: `${hour}:${minute}:${second}` };
  } catch {
    // An unrecognised zone throws. Saying nothing is the only honest answer.
    return null;
  }
}

/**
 * Whether the market is open, closed, or not something we can answer.
 *
 * `unknown` is a real outcome, not a failure to try: a security whose provider
 * never reported a session, or one held at a provider that reports none, has no
 * hours on record, and guessing them from the exchange code would produce a
 * confident wrong answer for exactly the instruments we know least about.
 *
 * Note this knows weekends but not holidays. A market closed for a public
 * holiday reads as open here, which is why the UI pairs the state with the
 * quote time -- a price that stopped updating hours ago is the visible symptom.
 */
export function getMarketState(
  session: MarketSession | null | undefined,
  now: Date = new Date(),
): MarketState {
  if (!session?.timezone || !session.openTime || !session.closeTime) {
    return 'unknown';
  }

  const local = localParts(session.timezone, now);
  if (!local) return 'unknown';
  if (local.weekday === 0 || local.weekday === 6) return 'closed';

  // Zero-padded 24-hour strings compare lexicographically in clock order.
  return local.time >= session.openTime && local.time < session.closeTime
    ? 'open'
    : 'closed';
}
