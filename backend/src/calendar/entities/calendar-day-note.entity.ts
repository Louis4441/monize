import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

/**
 * One free-text note on one calendar date, owned by one user.
 *
 * The unique constraint is the model: a date has at most one note, which is
 * what lets the write be a single `INSERT ... ON CONFLICT DO UPDATE` rather
 * than a read followed by a decision.
 */
@Entity("calendar_day_notes")
@Unique("uq_calendar_day_notes_user_date", ["userId", "noteDate"])
@Index("idx_calendar_day_notes_user_date", ["userId", "noteDate"])
export class CalendarDayNote {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  /** A calendar date, read and written as `YYYY-MM-DD` text, never as an instant. */
  @Column({ type: "date", name: "note_date" })
  noteDate: string;

  @Column({ type: "text" })
  body: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
