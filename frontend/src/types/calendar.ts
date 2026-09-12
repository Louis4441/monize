/**
 * One free-text note the reader keeps on a calendar date.
 *
 * Owner-only: an acting delegate has no note surface at all, and the server has
 * no route they could reach either (design decision 12).
 */
export interface DayNote {
  /** The day the note belongs to, `YYYY-MM-DD`. */
  date: string;
  body: string;
  /** When the server last stored it, ISO. The server's clock, not the browser's. */
  updatedAt: string;
}
