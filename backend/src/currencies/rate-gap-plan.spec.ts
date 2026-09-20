import {
  GAP_WINDOW_MAX_DAYS,
  planRateGapWindows,
  type RateGapWindow,
} from "./rate-gap-plan";

/** Inclusive length of a window, the unit the chunk bound is expressed in. */
function lengthOf(window: RateGapWindow): number {
  return (
    (Date.parse(`${window.end}T00:00:00Z`) -
      Date.parse(`${window.start}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

describe("planRateGapWindows", () => {
  describe("what counts as a gap", () => {
    it("does not treat a weekend as a gap", () => {
      // Friday's observation answers Saturday, Sunday and Monday by
      // carry-forward, so there is nothing to fetch.
      const plan = planRateGapWindows(
        ["2026-09-04"],
        "2026-09-04",
        "2026-09-07",
      );

      expect(plan.windows).toEqual([]);
      expect(plan.unresolvableDays).toBe(0);
    });

    it("does not treat a hole inside the carry-forward bound as a gap", () => {
      // The 15th of April is exactly 45 days after the 1st of March, which is
      // the oldest observation that may still stand for a date.
      const plan = planRateGapWindows(
        ["2026-03-01", "2026-04-15"],
        "2026-03-01",
        "2026-04-15",
      );

      expect(plan.windows).toEqual([]);
      expect(plan.unresolvableDays).toBe(0);
    });

    it("treats a hole past the carry-forward bound as a gap", () => {
      // One day further out, and the 16th to the 19th of April can be answered
      // by nothing: the 1st of March is too old and the 20th of April is after
      // them, which a historical lookup may not reach forwards to.
      const plan = planRateGapWindows(
        ["2026-03-01", "2026-04-20"],
        "2026-03-01",
        "2026-04-20",
      );

      expect(plan.unresolvableDays).toBe(4);
      expect(plan.windows).toEqual([
        // Padded back by the boundary lead, so the gap's first day has an
        // observation to carry forward from.
        { start: "2026-04-02", end: "2026-04-19" },
      ]);
    });

    it("plans the whole span when nothing is stored", () => {
      const plan = planRateGapWindows([], "2026-01-01", "2026-01-31");

      expect(plan.unresolvableDays).toBe(31);
      expect(plan.windows).toEqual([
        { start: "2025-12-18", end: "2026-01-31" },
      ]);
    });

    it("lets an observation before the span answer the span's first days", () => {
      // The caller passes observations from before `spanStart` for exactly
      // this reason; without them the span opens on a gap that is already
      // filled.
      const plan = planRateGapWindows(
        ["2025-12-20"],
        "2026-01-01",
        "2026-01-10",
      );

      expect(plan.windows).toEqual([]);
    });

    it("ignores an observation struck after the span", () => {
      // A rate from after a date never stands for it (INV-FX-001), so a row in
      // December is no evidence about January.
      const plan = planRateGapWindows(
        ["2026-12-31"],
        "2026-01-01",
        "2026-01-31",
      );

      expect(plan.unresolvableDays).toBe(31);
      expect(plan.windows).toHaveLength(1);
    });

    it("reads unsorted, duplicated input as the set of dates it is", () => {
      const sorted = planRateGapWindows(
        ["2026-03-01", "2026-04-20"],
        "2026-03-01",
        "2026-04-20",
      );
      const scrambled = planRateGapWindows(
        ["2026-04-20", "2026-03-01", "2026-04-20", "2026-03-01"],
        "2026-03-01",
        "2026-04-20",
      );

      expect(scrambled).toEqual(sorted);
    });

    it("plans nothing for a span that ends before it starts", () => {
      const plan = planRateGapWindows([], "2026-02-01", "2026-01-01");

      expect(plan).toEqual({
        windows: [],
        unresolvableDays: 0,
        remainingWindows: 0,
      });
    });
  });

  describe("the windows it asks for", () => {
    it("keeps two holes as two windows rather than re-fetching what is between them", () => {
      // The rows between two gaps are stored data, and a fetched window
      // overwrites whatever it covers. Two calls cost less than those rows.
      const plan = planRateGapWindows(
        ["2020-01-01", "2020-06-01", "2021-01-01"],
        "2020-01-01",
        "2021-01-01",
      );

      expect(plan.windows).toEqual([
        { start: "2020-02-02", end: "2020-05-31" },
        { start: "2020-07-03", end: "2020-12-31" },
      ]);
      expect(plan.windows[1].start > plan.windows[0].end).toBe(true);
    });

    it("splits a multi-year gap into windows the provider still answers daily", () => {
      const plan = planRateGapWindows([], "2020-01-01", "2022-06-30", 45, 99);

      expect(plan.windows).toHaveLength(3);
      for (const window of plan.windows) {
        expect(lengthOf(window)).toBeLessThanOrEqual(GAP_WINDOW_MAX_DAYS);
      }
      // Contiguous and complete: the chunking must not drop a day between one
      // window and the next.
      expect(plan.windows[0].start).toBe("2019-12-18");
      expect(plan.windows[2].end).toBe("2022-06-30");
      for (let i = 1; i < plan.windows.length; i++) {
        const previousEnd = Date.parse(`${plan.windows[i - 1].end}T00:00:00Z`);
        const start = Date.parse(`${plan.windows[i].start}T00:00:00Z`);
        expect(start - previousEnd).toBe(86_400_000);
      }
    });

    it("never asks for a date past the end of the span", () => {
      const plan = planRateGapWindows([], "2026-01-01", "2026-01-05");

      expect(plan.windows[0].end).toBe("2026-01-05");
    });
  });

  describe("the bound on one request", () => {
    it("keeps the oldest windows and reports the rest as remaining", () => {
      const uncapped = planRateGapWindows(
        [],
        "2010-01-01",
        "2020-01-01",
        45,
        999,
      );
      const capped = planRateGapWindows([], "2010-01-01", "2020-01-01", 45, 3);

      expect(uncapped.windows.length).toBeGreaterThan(3);
      expect(capped.windows).toEqual(uncapped.windows.slice(0, 3));
      expect(capped.remainingWindows).toBe(uncapped.windows.length - 3);
      // The count of what is missing describes the history, not the cap, so it
      // does not shrink when fewer windows are fetched.
      expect(capped.unresolvableDays).toBe(uncapped.unresolvableDays);
    });

    it("plans no window at all when the cap is zero", () => {
      const plan = planRateGapWindows([], "2026-01-01", "2026-01-31", 45, 0);

      expect(plan.windows).toEqual([]);
      expect(plan.remainingWindows).toBe(1);
    });
  });
});
