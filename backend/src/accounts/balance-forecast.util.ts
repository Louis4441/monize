import {
  FrequencyType,
  calculateNextDueDate,
  ensureYMD,
} from "../common/recurrence";

/**
 * Why an occurrence's amount could not be worked out, as a closed set so the
 * client can render actionable copy instead of parsing prose (issue #1247).
 *
 *  - `unresolvedSettlementRate` -- an investment-carrying schedule whose current
 *    settlement exchange rate is unknown, so what it will post is unknown.
 *  - `crossCurrencyTransfer` -- the schedule's amount is in the SOURCE account's
 *    currency and this projection is for the destination, whose currency differs.
 *    The arriving amount is resolved at posting time and no rate is applied here,
 *    so adding the source figure would be a foreign number on this balance.
 */
export type BalanceForecastGapReason =
  | "unresolvedSettlementRate"
  | "crossCurrencyTransfer";

/** One schedule the projection could not price, and why. */
export interface BalanceForecastGap {
  scheduledTransactionId: string;
  name: string;
  reason: BalanceForecastGapReason;
  /** The pair behind the gap, when there is one to name. */
  fromCurrency: string | null;
  toCurrency: string | null;
}

/** A per-occurrence override, as it affects the projection. */
export interface ForecastOverrideInput {
  /** The scheduled occurrence date this override replaces. */
  originalDate: string;
  /** The date the occurrence actually falls on. */
  overrideDate: string;
  /** The occurrence's effective amount, or null when it is unknown. */
  amount: number | null;
}

export interface ForecastScheduleInput {
  id: string;
  name: string;
  /**
   * The account this schedule's cash moves through -- for an investment schedule
   * the *settlement* account, not the brokerage (issue #1247). The caller
   * resolves it; this module only compares it against the account being charted.
   */
  accountId: string;
  transferAccountId: string | null;
  /**
   * The amount one occurrence would post today, or `null` when that cannot be
   * determined. `null` is never the persisted snapshot: an occurrence nobody can
   * price makes the running balance after it unknown, so it is reported as a gap
   * and the caller withholds the series.
   */
  amount: number | null;
  /** Set when `amount` is null, so the caller can say why. */
  gapReason?: BalanceForecastGapReason;
  gapFromCurrency?: string | null;
  gapToCurrency?: string | null;
  frequency: FrequencyType;
  nextDueDate: string;
  endDate: string | null;
  occurrencesRemaining: number | null;
  /** Per-occurrence overrides, keyed by the occurrence date they replace. */
  overrides?: ForecastOverrideInput[];
}

export interface ForecastPoint {
  date: string;
  balance: number;
}

function roundCents(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Add whole days to a `YYYY-MM-DD` string, returning `YYYY-MM-DD`. */
export function addDaysYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Whether this schedule moves money through `accountId` at all. */
function touchesAccount(s: ForecastScheduleInput, accountId: string): boolean {
  return s.accountId === accountId || s.transferAccountId === accountId;
}

/**
 * Signed effect `amount` has on `accountId` (a transfer's destination receives
 * the source's outflow, so it lands positive). Shared by the base occurrence and
 * by each override, so an override cannot pick up a different sign convention.
 */
function deltaFor(
  s: ForecastScheduleInput,
  accountId: string,
  amount: number,
): number {
  let delta = 0;
  if (s.accountId === accountId) delta += amount;
  if (s.transferAccountId === accountId) delta += Math.abs(amount);
  return delta;
}

/**
 * Accumulate scheduled occurrence deltas that fall strictly after `today` and
 * on or before `horizon` into a per-date map, merged with any `actualByDate`
 * (future-dated real transactions). Occurrences are expanded with the shared
 * recurrence stepper, respecting each schedule's end date and remaining count,
 * and a per-occurrence override moves the occurrence's date and replaces its
 * amount -- the same precedence the cash-flow forecast and the posting apply.
 *
 * Returns the gaps alongside the map: a schedule with an unknown amount whose
 * occurrences all fall outside the horizon does not affect this projection, so
 * "is this forecast complete" can only be answered while walking the dates
 * (issue #1247). The caller withholds the series when `gaps` is non-empty.
 */
export function accumulateForecastDeltas(
  schedules: ForecastScheduleInput[],
  accountId: string,
  today: string,
  horizon: string,
  actualByDate: Map<string, number> = new Map(),
): { byDate: Map<string, number>; gaps: BalanceForecastGap[] } {
  const byDate = new Map(actualByDate);
  const gaps: BalanceForecastGap[] = [];
  const addGap = (s: ForecastScheduleInput) => {
    if (gaps.some((g) => g.scheduledTransactionId === s.id)) return;
    gaps.push({
      scheduledTransactionId: s.id,
      name: s.name,
      reason: s.gapReason ?? "unresolvedSettlementRate",
      fromCurrency: s.gapFromCurrency ?? null,
      toCurrency: s.gapToCurrency ?? null,
    });
  };

  for (const s of schedules) {
    if (!touchesAccount(s, accountId)) continue;
    const overrideByOriginal = new Map(
      (s.overrides ?? []).map((o) => [ensureYMD(o.originalDate), o]),
    );
    let d = ensureYMD(s.nextDueDate);
    const end = s.endDate ? ensureYMD(s.endDate) : null;
    let remaining = s.occurrencesRemaining ?? Number.POSITIVE_INFINITY;
    let guard = 0;
    while (d <= horizon && remaining > 0 && guard++ < 2000) {
      if (end && d > end) break;
      const override = overrideByOriginal.get(d);
      // An override moves the occurrence; the projection lands it on the date it
      // will actually post, and only inside the window.
      const effectiveDate = override ? ensureYMD(override.overrideDate) : d;
      const amount = override ? override.amount : s.amount;
      if (effectiveDate > today && effectiveDate <= horizon) {
        if (amount === null) {
          addGap(s);
        } else {
          const delta = deltaFor(s, accountId, amount);
          // A zero delta contributes nothing, and emitting it would add a flat
          // point to the series for a day on which nothing happens.
          if (delta !== 0) {
            byDate.set(
              effectiveDate,
              roundCents((byDate.get(effectiveDate) ?? 0) + delta),
            );
          }
        }
      }
      remaining -= 1;
      if (s.frequency === "ONCE") break;
      const next = calculateNextDueDate(d, s.frequency);
      if (next <= d) break;
      d = next;
    }
  }
  return { byDate, gaps };
}

/**
 * Build a forecast balance series from `today` (anchored at `startBalance`)
 * through `horizon`, applying the per-date deltas. Emits a point at today plus
 * one at each date that carries a delta.
 */
export function buildForecastSeries(
  startBalance: number,
  today: string,
  horizon: string,
  deltaByDate: Map<string, number>,
): ForecastPoint[] {
  const dates = [...deltaByDate.keys()]
    .filter((d) => d > today && d <= horizon)
    .sort();
  let balance = roundCents(startBalance);
  const series: ForecastPoint[] = [{ date: today, balance }];
  for (const d of dates) {
    balance = roundCents(balance + (deltaByDate.get(d) ?? 0));
    series.push({ date: d, balance });
  }
  return series;
}
