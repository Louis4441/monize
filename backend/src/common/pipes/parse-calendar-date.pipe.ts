import { PipeTransform, Injectable, BadRequestException } from "@nestjs/common";

import { tr } from "../../i18n/translate";
import { isCalendarDate } from "../validators/is-calendar-date.validator";

/**
 * Validates a route parameter that is a calendar date.
 *
 * The counterpart of `ParseUUIDPipe` for a resource keyed by its day rather
 * than by an id. A shape check alone is not enough: `2026-02-30` and
 * `9999-99-99` match `\d{4}-\d{2}-\d{2}` and reach Postgres as date literals,
 * where they fail with "date/time field value out of range" -- a 500 for what is
 * plainly a client error.
 */
@Injectable()
export class ParseCalendarDatePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isCalendarDate(value)) {
      throw new BadRequestException(
        tr(
          "errors.common.calendarDateInvalid",
          "date must be a real YYYY-MM-DD calendar date",
        ),
      );
    }
    return value;
  }
}
