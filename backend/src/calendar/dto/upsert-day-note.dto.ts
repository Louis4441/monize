import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, MaxLength, MinLength } from "class-validator";

import { CALENDAR_DAY_NOTE_MAX_LENGTH } from "../../common/calendar-day-note";

/**
 * The body of a day note.
 *
 * Trimmed before validation, so whitespace cannot buy length and a body of
 * nothing but spaces is the blank it looks like. A blank body is a 400, NEVER a
 * delete: deleting is its own verb, and inferring it from an empty field would
 * make an accidentally cleared textarea destroy the note on save.
 *
 * The lower bound is also the database's: `ck_calendar_day_notes_body_length`
 * refuses an empty string, so without it the 400 would arrive as a constraint
 * violation with no field named.
 */
export class UpsertDayNoteDto {
  @ApiProperty({ maxLength: CALENDAR_DAY_NOTE_MAX_LENGTH })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: "body must not be blank" })
  @MaxLength(CALENDAR_DAY_NOTE_MAX_LENGTH)
  body: string;
}
