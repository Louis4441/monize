/**
 * How long a calendar day note may be.
 *
 * The server's copy is `backend/src/common/calendar-day-note.ts` and the
 * database's is the `ck_calendar_day_notes_body_length` CHECK; all three must
 * agree. Below the server's number a form truncates text the user may
 * legitimately store, above it the form accepts a save the server then rejects
 * with nothing pointing at the field.
 *
 * `backend/src/common/calendar-day-note.contract.spec.ts` reads this file and
 * fails when the numbers differ.
 */
export const CALENDAR_DAY_NOTE_MAX_LENGTH = 2000;
