import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";

import { ParseCalendarDatePipe } from "../common/pipes/parse-calendar-date.pipe";
import { CalendarDayNotesService, DayNote } from "./calendar-day-notes.service";
import { DayNotesQueryDto } from "./dto/day-notes-query.dto";
import { UpsertDayNoteDto } from "./dto/upsert-day-note.dto";

/**
 * A user's own notes on calendar dates.
 *
 * Deliberately NOT `@AllowDelegate`: a note is the owner's own writing about
 * their own day, and sharing it with a delegate is a separate product decision
 * nobody has made (design decision 12). A delegate acting for an owner sees no
 * note surface at all, which is why there is no read arm here either -- an
 * endpoint a delegate could read would make the client's hiding of the section
 * the only thing keeping it private.
 *
 * `userId` comes from the JWT on every route and is never read from the request.
 */
@ApiTags("Calendar")
@Controller("calendar/day-notes")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class CalendarDayNotesController {
  constructor(private readonly dayNotes: CalendarDayNotesService) {}

  @Get()
  @ApiOperation({ summary: "List the caller's day notes in a date range" })
  @ApiResponse({ status: 200, description: "Notes returned, oldest day first" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async list(
    @Request() req,
    @Query() query: DayNotesQueryDto,
  ): Promise<DayNote[]> {
    return this.dayNotes.list(req.user.id, query.startDate, query.endDate);
  }

  @Put(":date")
  @ApiOperation({ summary: "Write the caller's note for one day" })
  @ApiParam({ name: "date", example: "2026-06-15" })
  @ApiResponse({ status: 200, description: "The stored note" })
  @ApiResponse({ status: 400, description: "Blank, too long, or not a date" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async upsert(
    @Request() req,
    @Param("date", ParseCalendarDatePipe) date: string,
    @Body() body: UpsertDayNoteDto,
  ): Promise<DayNote> {
    return this.dayNotes.upsert(req.user.id, date, body.body);
  }

  @Delete(":date")
  @HttpCode(204)
  @ApiOperation({ summary: "Remove the caller's note for one day" })
  @ApiParam({ name: "date", example: "2026-06-15" })
  @ApiResponse({
    status: 204,
    description:
      "The day holds no note. Idempotent: a day that held none succeeds too.",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async remove(
    @Request() req,
    @Param("date", ParseCalendarDatePipe) date: string,
  ): Promise<void> {
    await this.dayNotes.remove(req.user.id, date);
  }
}
