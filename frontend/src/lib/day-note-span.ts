import { calendarDaysBetween, shiftDate } from '@/lib/calendar-month';
import type { DayNote } from '@/types/calendar';

/**
 * Where one day sits in the note that covers it.
 *
 * The cell draws a note differently at each end of a run than in the middle of
 * one, so a reader scanning a month sees a vacation as one bar rather than five
 * unrelated pencils. `only` is the one-day note, which is most of them.
 */
export type DayNoteSpanPosition = 'only' | 'start' | 'middle' | 'end';

/**
 * Every day each note covers, keyed by day.
 *
 * The server refuses overlapping spans for one user, so a day is claimed by at
 * most one note and this map never has to choose between two. It is what lets
 * the panel ask "the note for this day" and the editor be opened from any day a
 * span touches -- the note it returns carries its own `startDate`, which is what
 * the save is anchored on.
 *
 * Days outside `[gridStart, gridEnd]` are not expanded: a note running a year
 * past the month on screen would otherwise put 365 entries in a map the grid
 * reads 42 of.
 */
export function dayNotesByDay(
  notes: readonly DayNote[],
  gridStart: string,
  gridEnd: string,
): Map<string, DayNote> {
  const byDay = new Map<string, DayNote>();
  for (const note of notes) {
    const from = note.startDate < gridStart ? gridStart : note.startDate;
    const to = note.endDate > gridEnd ? gridEnd : note.endDate;
    // A note entirely outside the grid: the range query should not have
    // returned it, and expanding it backwards would be a loop that never ends.
    if (from > to) continue;
    for (let day = from; day <= to; day = shiftDate(day, 1)) {
      byDay.set(day, note);
    }
  }
  return byDay;
}

/** How many days `note` covers; `1` for a one-day note. */
export function dayNoteSpanLength(note: DayNote): number {
  return calendarDaysBetween(note.startDate, note.endDate);
}

/** Whether `note` covers more than the day it starts on. */
export function isMultiDayNote(note: DayNote): boolean {
  return note.endDate > note.startDate;
}

/** Where `date` sits in `note`'s run of days. */
export function dayNoteSpanPosition(note: DayNote, date: string): DayNoteSpanPosition {
  if (!isMultiDayNote(note)) return 'only';
  if (date <= note.startDate) return 'start';
  if (date >= note.endDate) return 'end';
  return 'middle';
}
