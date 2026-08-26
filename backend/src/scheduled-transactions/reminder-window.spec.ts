import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  MAX_REMINDER_DAYS_BEFORE,
  reminderWindowThrough,
} from "./reminder-window";
import { CreateScheduledTransactionDto } from "./dto/create-scheduled-transaction.dto";
import { expandOccurrenceSlots } from "../common/scheduled-occurrences";

/**
 * A reminder window is a date range, and every way of producing a non-date one is
 * closed.
 *
 * The defect: `reminder_days_before` was unbounded, so a value past `Date`'s
 * range made `addDaysYMD` return the literal string "NaN-NaN-NaN".
 * `expandOccurrenceSlots` compares window bounds as text, and
 * `"2026-08-26" <= "NaN-NaN-NaN"` is true because digits sort before letters --
 * so the expander reported every occurrence of every bill as falling inside
 * today's reminder window, walked each schedule to its 2000-step guard, and the
 * daily cron every tenant shares emailed reminders for bills due years out, every
 * day. Three independent closures, one per test group below.
 */
describe("reminder window", () => {
  const today = "2026-08-26";

  describe("the window bound", () => {
    it("treats a null notice period as due-today-only", () => {
      // Nullable column. `addDaysYMD(today, null)` happens to return today
      // (`n + null === n`), but the caller must not depend on that arithmetic.
      expect(reminderWindowThrough(today, null)).toBe(today);
      expect(reminderWindowThrough(today, undefined)).toBe(today);
    });

    it("keeps an ordinary notice period", () => {
      expect(reminderWindowThrough(today, 3)).toBe("2026-08-29");
    });

    it("clamps a value that would overflow the date range", () => {
      // The stored value that produced "NaN-NaN-NaN".
      expect(reminderWindowThrough(today, 100_000_000)).toBe(
        reminderWindowThrough(today, MAX_REMINDER_DAYS_BEFORE),
      );
      expect(reminderWindowThrough(today, 100_000_000)).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    it("refuses to look backwards", () => {
      expect(reminderWindowThrough(today, -30)).toBe(today);
    });
  });

  describe("the DTO", () => {
    const dtoFor = (reminderDaysBefore: unknown) =>
      plainToInstance(CreateScheduledTransactionDto, {
        name: "Rent",
        accountId: "11111111-1111-1111-1111-111111111111",
        amount: -1200,
        frequency: "MONTHLY",
        nextDueDate: "2026-09-01",
        reminderDaysBefore,
      });

    const errorsFor = async (value: unknown) =>
      (await validate(dtoFor(value))).filter(
        (e) => e.property === "reminderDaysBefore",
      );

    it("accepts a sane notice period", async () => {
      expect(await errorsFor(3)).toHaveLength(0);
      expect(await errorsFor(MAX_REMINDER_DAYS_BEFORE)).toHaveLength(0);
    });

    it("rejects a value past the ceiling", async () => {
      expect(await errorsFor(MAX_REMINDER_DAYS_BEFORE + 1)).not.toHaveLength(0);
      expect(await errorsFor(100_000_000)).not.toHaveLength(0);
    });

    it("rejects a fraction, which an INTEGER column cannot store", async () => {
      expect(await errorsFor(0.5)).not.toHaveLength(0);
    });

    it("rejects a negative notice period", async () => {
      expect(await errorsFor(-1)).not.toHaveLength(0);
    });
  });

  describe("the expander", () => {
    const schedule = {
      frequency: "DAILY" as const,
      // Years away: nowhere near any reminder window.
      nextDueDate: "2030-01-01",
      endDate: null,
      occurrencesRemaining: null,
    };

    it("refuses a window bound that is not a date, rather than matching everything", () => {
      expect(() =>
        expandOccurrenceSlots(schedule, [], {
          from: today,
          through: "NaN-NaN-NaN",
          maxOccurrences: 1,
        }),
      ).toThrow(RangeError);
    });

    it("refuses a non-date lower bound too", () => {
      expect(() =>
        expandOccurrenceSlots(schedule, [], {
          from: "NaN-NaN-NaN",
          through: "2026-09-30",
        }),
      ).toThrow(RangeError);
    });

    it("still answers an ordinary window", () => {
      expect(
        expandOccurrenceSlots(schedule, [], {
          from: today,
          through: "2026-08-31",
          maxOccurrences: 1,
        }),
      ).toEqual([]);
      expect(
        expandOccurrenceSlots(schedule, [], {
          from: "2030-01-01",
          through: "2030-01-02",
        }),
      ).toHaveLength(2);
    });
  });
});
