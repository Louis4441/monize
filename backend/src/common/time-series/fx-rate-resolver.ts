/**
 * The one door between the stored exchange-rate history and "the rate for this
 * date".
 *
 * Four resolvers used to answer this question -- the chart index, the posting
 * ladder, the intraday portfolio index and the investment report -- and they
 * disagreed on every part of it: whether a rate from *after* the valuation date
 * may be used, how old a carried-forward rate may be, whether an inverse
 * observation is consulted when a direct one exists, and whether the answer for
 * a date depends on how wide the surrounding window happened to be. One session
 * could therefore quote four different EUR rates.
 *
 * The rules this module holds, none of which a caller may restate:
 *
 *  - **Never look ahead.** In `historical` mode the answer is the most recent
 *    observation dated on or *before* the date being priced. An observation
 *    struck after that date did not exist when the date happened, so it is not
 *    evidence about it, however close it is.
 *  - **A carried-forward rate has a maximum age** (`FX_MAX_RATE_AGE_DAYS`).
 *    Beyond it the date's rate is unknown, not "the last one we have":
 *    `docs/time-series-contract.md` section 2.2 -- an exchange rate is a price,
 *    and a nine-month-old price does not describe today.
 *  - **The more recent admissible observation wins**, whichever direction it is
 *    stored in; a tie goes to the direct pair. An old direct row must not block
 *    a fresh inverse one, and the choice must not depend on map iteration order.
 *  - **Rate 1 only for equal codes**, and only without a lookup. A missing code
 *    is unknown, never 1 (INV-FX-001).
 *  - **A non-positive stored rate is absent**, not applicable: multiplying by 0
 *    reports a real holding as worthless.
 *  - **An unknown answer names its cause**, so a surface can tell "this pair was
 *    never observed" from "your history has a 285-day hole".
 *
 * `live` mode is the current-rate path: it may take the freshest observation
 * rather than one dated on or before the reference date, under the same age
 * bound. It is still not a licence to use a year-old rate.
 */
import { daysBetween } from "./price-boundary.util";

/** One stored observation of a pair, as stored (never pre-inverted). */
export interface DatedRate {
  date: string;
  rate: number;
}

/**
 * The observations stored for one direction of a pair, ascending or in any
 * order; the resolver decides which one applies rather than trusting position.
 */
export type FxObservationLookup = (
  from: string,
  to: string,
) => ReadonlyArray<DatedRate> | undefined;

/** Which question is being asked: a historical valuation, or "right now". */
export type FxRateMode = "historical" | "live";

/** Why an answer is unknown; one cause, one repair. */
export type FxRateGapReason =
  /** A currency code was empty, so there is no pair to look up. */
  | "unknown_currency"
  /** Neither direction has ever been observed. */
  | "no_observation"
  /** Every observation is dated after the valuation date (the removed look-ahead). */
  | "only_after_date"
  /** The newest admissible observation is older than the age bound. */
  | "stale_observation";

/** What the resolver found, and how. */
export interface FxRateResolution {
  status: "resolved" | "same_currency" | "unknown";
  /** Multiply an amount in `from` by this to get `to`. `null` when unknown. */
  rate: number | null;
  /** The observation as stored, before any inversion. */
  observedRate: number | null;
  /** The date the chosen observation was struck on. */
  observedOn: string | null;
  direction: "direct" | "inverse" | "identity" | null;
  /** Whole days between the observation and the date it is standing in for. */
  ageDays: number | null;
  reason: FxRateGapReason | null;
}

/**
 * How stale a stored rate may be and still stand for a date.
 *
 * A calendar date is very often one the FX market was shut on: every weekend,
 * plus each side's public holidays, plus the stretches a provider simply did
 * not return. Carrying Friday's rate to Monday is the whole point of a
 * carry-forward, so the bound has to be comfortably longer than a long weekend
 * and the odd provider outage -- and short enough that it still describes the
 * date. Forty-five days is the window `getRateForDate` already fetched history
 * over, so the bound and the fetch agree by construction: anything the bound
 * accepts is inside the span the service tries to fill.
 *
 * The limit is the point. Without one, a pair last observed in September
 * answers a lookup for the following June with September's number, and the
 * resulting total is wrong by the year's currency move with nothing on the page
 * saying so.
 */
export const FX_MAX_RATE_AGE_DAYS = 45;

interface Candidate {
  date: string;
  observedRate: number;
  rate: number;
  direction: "direct" | "inverse";
  ageDays: number;
}

interface Rejections {
  sawAnyObservation: boolean;
  sawAfterDate: boolean;
  sawStale: boolean;
}

/** The newest admissible observation in one stored direction, or null. */
function bestInDirection(
  rows: ReadonlyArray<DatedRate> | undefined,
  direction: "direct" | "inverse",
  onDate: string,
  mode: FxRateMode,
  maxAgeDays: number,
  seen: Rejections,
): Candidate | null {
  if (!rows || rows.length === 0) return null;

  let best: Candidate | null = null;
  for (const row of rows) {
    const observedRate = Number(row.rate);
    // Zero and negative are absent, not applicable -- the same reading
    // `convertWithRateLookup` gives them.
    if (!Number.isFinite(observedRate) || observedRate <= 0) continue;
    const date = row.date.slice(0, 10);
    if (!date) continue;
    seen.sawAnyObservation = true;

    const ageDays = daysBetween(date, onDate);
    if (ageDays < 0 && mode === "historical") {
      // Look-ahead: this observation did not exist on the date being priced.
      seen.sawAfterDate = true;
      continue;
    }
    if (Math.abs(ageDays) > maxAgeDays) {
      seen.sawStale = true;
      continue;
    }

    // Strictly newer wins; equal dates in one direction are the same day's
    // observation and the first is kept, so the answer does not depend on row
    // order.
    if (best !== null && date <= best.date) continue;
    best = {
      date,
      observedRate,
      rate: direction === "direct" ? observedRate : 1 / observedRate,
      direction,
      ageDays,
    };
  }
  return best;
}

const UNKNOWN_SHAPE = {
  status: "unknown",
  rate: null,
  observedRate: null,
  observedOn: null,
  direction: null,
  ageDays: null,
} as const;

/**
 * The rate that converts one unit of `from` into `to` on `onDate`.
 *
 * `lookup` is handed the pair in a stored direction and returns that
 * direction's observations; the resolver asks for both directions and picks
 * between them, so no caller repeats the direct/inverse decision.
 */
export function resolveFxRate(
  from: string,
  to: string,
  onDate: string,
  lookup: FxObservationLookup,
  options?: {
    mode?: FxRateMode;
    maxAgeDays?: number;
    /** Today, for clamping a future valuation date. Defaults to the UTC date. */
    today?: string;
  },
): FxRateResolution {
  const mode = options?.mode ?? "historical";
  const maxAgeDays = options?.maxAgeDays ?? FX_MAX_RATE_AGE_DAYS;

  // An empty code is not a pair. Returning 1 for it is the INV-FX-001 defect
  // wearing a different hat: a column headed in the base currency carrying a
  // foreign number.
  if (!from || !to) {
    return { ...UNKNOWN_SHAPE, reason: "unknown_currency" };
  }
  // The only branch that may produce 1, and it never consults the history.
  if (from === to) {
    return {
      status: "same_currency",
      rate: 1,
      observedRate: 1,
      observedOn: null,
      direction: "identity",
      ageDays: 0,
      reason: null,
    };
  }

  const today = options?.today ?? new Date().toISOString().slice(0, 10);
  // A date in the future has no rate and will not until it arrives; today's is
  // the best available estimate, and it is what every "as of" surface shows.
  // In `live` mode the reference is today outright.
  const requested = onDate.slice(0, 10);
  const reference =
    mode === "live" ? today : requested > today ? today : requested;

  const seen: Rejections = {
    sawAnyObservation: false,
    sawAfterDate: false,
    sawStale: false,
  };
  const direct = bestInDirection(
    lookup(from, to),
    "direct",
    reference,
    mode,
    maxAgeDays,
    seen,
  );
  const inverse = bestInDirection(
    lookup(to, from),
    "inverse",
    reference,
    mode,
    maxAgeDays,
    seen,
  );

  // The more recent admissible observation wins whichever way it is stored; a
  // tie goes to the direct pair, so the answer is the same on every run.
  const chosen =
    direct === null
      ? inverse
      : inverse === null
        ? direct
        : inverse.date > direct.date
          ? inverse
          : direct;

  if (chosen === null) {
    const reason: FxRateGapReason = seen.sawStale
      ? "stale_observation"
      : seen.sawAfterDate
        ? "only_after_date"
        : "no_observation";
    return { ...UNKNOWN_SHAPE, reason };
  }

  return {
    status: "resolved",
    rate: chosen.rate,
    observedRate: chosen.observedRate,
    observedOn: chosen.date,
    direction: chosen.direction,
    ageDays: chosen.ageDays,
    reason: null,
  };
}

/**
 * The rate as a plain number, or `null`. For a caller that has nothing to say
 * about *why* a pair is unknown; anything reporting a gap to a person should
 * read the resolution and keep its `reason`.
 */
export function resolveFxRateValue(
  from: string,
  to: string,
  onDate: string,
  lookup: FxObservationLookup,
  options?: Parameters<typeof resolveFxRate>[4],
): number | null {
  return resolveFxRate(from, to, onDate, lookup, options).rate;
}

/** One line a log or a payload can carry to explain a withheld figure. */
export function describeFxGap(
  pair: string,
  onDate: string,
  reason: FxRateGapReason,
  maxAgeDays: number = FX_MAX_RATE_AGE_DAYS,
): string {
  switch (reason) {
    case "unknown_currency":
      return `No currency pair to resolve for ${pair}; the affected figure is reported as unknown rather than converted 1:1`;
    case "only_after_date":
      return `Every stored ${pair} rate is dated after ${onDate}; the affected figure is reported as unknown rather than valued at a rate from its future`;
    case "stale_observation":
      return `The newest stored ${pair} rate on or before ${onDate} is more than ${maxAgeDays} days old; the affected figure is reported as unknown rather than carried forward`;
    case "no_observation":
    default:
      return `No exchange rate available for ${pair} on or before ${onDate}; the affected figure is reported as unknown rather than converted 1:1`;
  }
}
