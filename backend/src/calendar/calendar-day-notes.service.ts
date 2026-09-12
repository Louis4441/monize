import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";

/** One day note, as every route returns it. */
export interface DayNote {
  date: string;
  body: string;
  updatedAt: string;
}

/** The row shape the three statements below select. */
interface DayNoteRow {
  note_date: string;
  body: string;
  updated_at: string | Date;
}

/**
 * Read and write the one note a user may keep on a calendar date.
 *
 * The calendar's only write path, and it moves no money: nothing financial
 * reads this table, no balance cache is invalidated by a save, and the routes
 * are owner-only (a delegate acting for the owner gets no note surface at all).
 *
 * The write is **one statement**: `INSERT ... ON CONFLICT (user_id, note_date)
 * DO UPDATE`. Not a convenience -- a read-then-decide would let two saves of the
 * same day interleave, and the second would either lose the first or fail on the
 * unique constraint it did not expect. The constraint is the mechanism; the
 * statement is how it gets used (INV-DAYNOTE-001,
 * `docs/concurrency-and-idempotency.md`).
 *
 * `userId` is the caller's, from the JWT, on every route. It is never read from
 * the request, and the RLS policy on the table is the second line of that same
 * defence.
 */
@Injectable()
export class CalendarDayNotesService {
  constructor(private readonly dataSource: DataSource) {}

  /** Every note the user holds in the range, oldest day first. */
  async list(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<DayNote[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<DayNoteRow>(
        await m.query(
          `SELECT note_date::TEXT AS note_date, body, updated_at
             FROM calendar_day_notes
            WHERE user_id = $1
              AND note_date >= $2::DATE
              AND note_date <= $3::DATE
            ORDER BY note_date`,
          [userId, startDate, endDate],
        ),
      ),
    );
    return rows.map(toDayNote);
  }

  /**
   * Write the note for one day, whole.
   *
   * Returns the stored row rather than echoing the request: `updated_at` is the
   * database's, and a client that adopts a response has to be adopting what was
   * actually saved.
   */
  async upsert(userId: string, date: string, body: string): Promise<DayNote> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<DayNoteRow>(
        await m.query(
          `INSERT INTO calendar_day_notes (user_id, note_date, body)
                VALUES ($1, $2::DATE, $3)
           ON CONFLICT ON CONSTRAINT uq_calendar_day_notes_user_date
           DO UPDATE SET body = EXCLUDED.body, updated_at = CURRENT_TIMESTAMP
             RETURNING note_date::TEXT AS note_date, body, updated_at`,
          [userId, date, body],
        ),
      ),
    );
    return toDayNote(rows[0]);
  }

  /**
   * Remove the note for one day.
   *
   * Idempotent: deleting a day that holds no note succeeds. A 404 here would
   * describe a state the caller asked for and already has, and would turn a
   * double-click into an error.
   */
  async remove(userId: string, date: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `DELETE FROM calendar_day_notes
          WHERE user_id = $1 AND note_date = $2::DATE`,
        [userId, date],
      ),
    );
  }
}

function toDayNote(row: DayNoteRow): DayNote {
  return {
    date: row.note_date,
    body: row.body,
    updatedAt:
      typeof row.updated_at === "string"
        ? row.updated_at
        : row.updated_at.toISOString(),
  };
}
