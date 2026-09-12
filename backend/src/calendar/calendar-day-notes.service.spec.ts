import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { CalendarDayNotesService } from "./calendar-day-notes.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("CalendarDayNotesService", () => {
  let service: CalendarDayNotesService;
  let mocks: ReturnType<typeof createScopedDbMocks>;

  const lastQuery = () => {
    const calls = mocks.manager.query.mock.calls;
    return {
      sql: calls[calls.length - 1][0],
      params: calls[calls.length - 1][1],
    };
  };

  beforeEach(async () => {
    mocks = createScopedDbMocks();
    mocks.manager.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarDayNotesService,
        { provide: DataSource, useValue: mocks.dataSource },
      ],
    }).compile();

    service = module.get(CalendarDayNotesService);
  });

  describe("list", () => {
    it("returns the user's notes for the range, as calendar dates", async () => {
      mocks.manager.query.mockResolvedValue([
        {
          note_date: "2026-06-14",
          body: "Rent moved",
          updated_at: new Date("2026-06-14T10:00:00.000Z"),
        },
      ]);

      const notes = await service.list("user-1", "2026-06-01", "2026-06-30");

      expect(notes).toEqual([
        {
          date: "2026-06-14",
          body: "Rent moved",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
      ]);
      // `note_date::TEXT`, not the entity transformer: a DATE read as a Date is
      // an instant in the server's zone, which shifts the day west of UTC.
      expect(lastQuery().sql).toContain("note_date::TEXT");
      expect(lastQuery().params).toEqual([
        "user-1",
        "2026-06-01",
        "2026-06-30",
      ]);
    });

    it("filters by the caller's own id, always", async () => {
      await service.list("user-1", "2026-06-01", "2026-06-30");
      expect(lastQuery().sql).toContain("WHERE user_id = $1");
    });

    it("orders by date so the client need not sort", async () => {
      await service.list("user-1", "2026-06-01", "2026-06-30");
      expect(lastQuery().sql).toContain("ORDER BY note_date");
    });
  });

  describe("upsert", () => {
    beforeEach(() => {
      mocks.manager.query.mockResolvedValue([
        {
          note_date: "2026-06-14",
          body: "Rent moved",
          updated_at: "2026-06-14T10:00:00.000Z",
        },
      ]);
    });

    it("writes in ONE statement, on conflict of the unique constraint", async () => {
      await service.upsert("user-1", "2026-06-14", "Rent moved");

      // One statement is the whole concurrency argument: a read-then-decide
      // would let two saves of the same day interleave.
      expect(mocks.manager.query).toHaveBeenCalledTimes(1);
      const { sql, params } = lastQuery();
      expect(sql).toContain("INSERT INTO calendar_day_notes");
      expect(sql).toContain(
        "ON CONFLICT ON CONSTRAINT uq_calendar_day_notes_user_date",
      );
      expect(sql).toContain("DO UPDATE SET body = EXCLUDED.body");
      expect(sql).not.toContain("SELECT");
      expect(params).toEqual(["user-1", "2026-06-14", "Rent moved"]);
    });

    it("returns the stored row, not an echo of the request", async () => {
      const note = await service.upsert("user-1", "2026-06-14", "Rent moved");

      // `updatedAt` is the database's; a client that adopts the response has to
      // be adopting what was actually saved.
      expect(note).toEqual({
        date: "2026-06-14",
        body: "Rent moved",
        updatedAt: "2026-06-14T10:00:00.000Z",
      });
      expect(lastQuery().sql).toContain("RETURNING");
    });

    it("refreshes updated_at on the update arm", async () => {
      await service.upsert("user-1", "2026-06-14", "Rent moved");
      expect(lastQuery().sql).toContain("updated_at = CURRENT_TIMESTAMP");
    });
  });

  describe("remove", () => {
    it("deletes only the caller's note for that day", async () => {
      await service.remove("user-1", "2026-06-14");

      const { sql, params } = lastQuery();
      expect(sql).toContain("DELETE FROM calendar_day_notes");
      expect(sql).toContain("WHERE user_id = $1 AND note_date = $2::DATE");
      expect(params).toEqual(["user-1", "2026-06-14"]);
    });

    it("is idempotent: a day with no note is not an error", async () => {
      mocks.manager.query.mockResolvedValue([[], 0]);
      await expect(
        service.remove("user-1", "2026-06-14"),
      ).resolves.toBeUndefined();
    });
  });
});
