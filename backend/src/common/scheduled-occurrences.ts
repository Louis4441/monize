import { FrequencyType, calculateNextDueDate, ensureYMD } from "./recurrence";

/**
 * Hard bound on how many recurrence steps one schedule is walked in a single
 * expansion. A daily schedule over a five-year horizon is under 2000 steps, so
 * this is a runaway backstop (a frequency whose stepper failed to advance is
 * already caught by the monotonicity check) rather than a product limit.
 */
export const OCCURRENCE_WALK_GUARD = 2000;

/** A window bound is a calendar date, because that is what it is compared as. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function assertWindowDate(value: string, field: "from" | "through"): void {
  if (!YMD.test(value)) {
    throw new RangeError(
      `expandOccurrenceSlots: window.${field} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * The half of a per-occurrence override that decides WHICH occurrence it is and
 * WHEN that occurrence falls. Deliberately not the amount: this module answers
 * occurrence identity, and the amount is the effective-amount service's answer.
 */
export interface OccurrenceOverrideInput {
  /**
   * The recurrence slot this override replaces. This -- not `overrideDate` -- is
   * the occurrence's identity, and the database says so: the unique index is
   * `(scheduled_transaction_id, original_date)`. Keying an override lookup on
   * `overrideDate` silently misses every occurrence the user moved.
   */
  originalDate: string | Date;
  /** The date the occurrence actually falls on. Equal to `originalDate` unless moved. */
  overrideDate: string | Date;
}

export interface OccurrenceScheduleInput {
  frequency: FrequencyType;
  nextDueDate: string | Date;
  endDate?: string | Date | null;
  occurrencesRemaining?: number | null;
}

export interface OccurrenceWindow {
  /**
   * Inclusive lower bound on the date the occurrence actually falls on. Omit to
   * include occurrences already overdue -- a bill whose due date has passed is
   * exactly what an upcoming-bills surface must still show.
   */
  from?: string;
  /** Inclusive upper bound on the date the occurrence actually falls on. */
  through: string;
  /**
   * Cap on how many occurrences of ONE schedule are returned, applied after
   * ordering by due date. `1` means "the next occurrence", which is what a
   * surface reporting one row per schedule wants.
   */
  maxOccurrences?: number;
}

export interface ExpandedOccurrence<O> {
  /** The recurrence slot -- the occurrence's identity (see `originalDate` above). */
  originalDate: string;
  /** The date it falls on: the override's date when one moved it, else `originalDate`. */
  dueDate: string;
  /** The override governing this occurrence, or null when it runs on the base template. */
  override: O | null;
  /** True when an override moved this occurrence off its recurrence slot. */
  moved: boolean;
}

/**
 * Expand one schedule's recurrence into the occurrences that fall inside
 * `window`, applying each per-occurrence override's date move.
 *
 * This is the single place a scheduled recurrence is walked over a window and
 * matched against its overrides (issue #1247). It exists because occurrence
 * *selection* was distributed even after the effective-amount arithmetic was
 * centralized: every consumer still had to know that the identity is
 * `originalDate`, that `overrideDate` moves the occurrence, and how the two
 * interact with the window -- and the budget alert path got it wrong by keying
 * the lookup on `overrideDate`, so a moved occurrence read the base template.
 *
 * Two window subtleties the callers used to get wrong, both of them tested:
 *
 *  - **An override can move an occurrence INTO the window from beyond it.** The
 *    walk therefore runs past `through` as far as the furthest recurrence slot
 *    whose override lands inside, instead of stopping at `through` and losing it.
 *  - **An override can move an occurrence OUT of the window.** Filtering is on
 *    the date the occurrence actually falls on, never on the recurrence slot.
 *
 * `maxOccurrences` is applied after ordering by `dueDate`, so "the next
 * occurrence" is the next one to actually happen -- not the earliest recurrence
 * slot, which a backward move can push behind a later one.
 */
export function expandOccurrenceSlots<O extends OccurrenceOverrideInput>(
  schedule: OccurrenceScheduleInput,
  overrides: readonly O[],
  window: OccurrenceWindow,
): ExpandedOccurrence<O>[] {
  // The window is compared as text, so a bound that is not a date fails OPEN
  // rather than closed: `"2026-08-26" <= "NaN-NaN-NaN"` is true (digits sort
  // before letters), so every slot passed both the walk condition and the
  // filter, and the caller got "due today" for a bill years away. That is how an
  // unbounded `reminderDaysBefore` overflowing `addDaysYMD` turned into a daily
  // reminder for every one of a user's manual bills. Refuse the input instead:
  // no caller has a meaning for a non-date window, and a silent all-match is the
  // worst of the three possible answers.
  assertWindowDate(window.through, "through");
  if (window.from !== undefined) assertWindowDate(window.from, "from");

  const byOriginal = new Map<string, O>();
  for (const override of overrides) {
    const key = ensureYMD(override.originalDate as string);
    if (!byOriginal.has(key)) byOriginal.set(key, override);
  }

  // How far the recurrence has to be walked: past `through` when an override
  // moved a later slot's occurrence back into the window.
  let walkThrough = window.through;
  for (const [originalDate, override] of byOriginal) {
    const dueDate = ensureYMD(override.overrideDate as string);
    if (dueDate <= window.through && originalDate > walkThrough) {
      walkThrough = originalDate;
    }
  }

  const found: ExpandedOccurrence<O>[] = [];
  const endDate = schedule.endDate ? ensureYMD(schedule.endDate) : null;
  let remaining = schedule.occurrencesRemaining ?? Number.POSITIVE_INFINITY;
  let slot = ensureYMD(schedule.nextDueDate);
  let guard = 0;

  while (
    slot <= walkThrough &&
    remaining > 0 &&
    guard++ < OCCURRENCE_WALK_GUARD
  ) {
    if (endDate && slot > endDate) break;
    const override = byOriginal.get(slot) ?? null;
    const dueDate = override
      ? ensureYMD(override.overrideDate as string)
      : slot;
    if (
      dueDate <= window.through &&
      (window.from === undefined || dueDate >= window.from)
    ) {
      found.push({
        originalDate: slot,
        dueDate,
        override,
        moved: dueDate !== slot,
      });
    }
    remaining -= 1;
    if (schedule.frequency === "ONCE") break;
    const next = calculateNextDueDate(slot, schedule.frequency);
    // A stepper that fails to advance would loop until the guard; stopping here
    // keeps a malformed frequency from silently emitting the same date 2000 times.
    if (next <= slot) break;
    slot = next;
  }

  const ordered = found.sort((a, b) =>
    a.dueDate === b.dueDate
      ? a.originalDate.localeCompare(b.originalDate)
      : a.dueDate.localeCompare(b.dueDate),
  );
  return window.maxOccurrences === undefined
    ? ordered
    : ordered.slice(0, window.maxOccurrences);
}
