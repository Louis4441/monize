import {
  EMPTY_INCOMPLETE_RANGES,
  MAX_INCOMPLETE_RANGES_PER_CAUSE,
  foldIncompleteData,
  hasIncompleteData,
} from "./incomplete-data-ranges.util";

/**
 * The cases are the client fold's own
 * (`frontend/src/lib/incomplete-data-ranges.test.ts`), ported so the two cannot
 * disagree about which days belong to one outage, plus the bound this side
 * carries because its output travels on every period response.
 */
describe("foldIncompleteData", () => {
  it("reports nothing for a complete series", () => {
    const ranges = foldIncompleteData([
      { date: "2026-06-15" },
      { date: "2026-06-16", unpricedSecurityIds: [], missingRatePairs: [] },
    ]);
    expect(ranges).toEqual(EMPTY_INCOMPLETE_RANGES);
    expect(hasIncompleteData(ranges)).toBe(false);
  });

  it("folds consecutive points into one range per security", () => {
    const ranges = foldIncompleteData([
      { date: "2026-06-15" },
      { date: "2026-06-16", unpricedSecurityIds: ["sec-a"] },
      { date: "2026-06-17", unpricedSecurityIds: ["sec-a"] },
      { date: "2026-06-18", unpricedSecurityIds: ["sec-a"] },
      { date: "2026-06-19" },
    ]);
    expect(ranges.prices).toEqual([
      { key: "sec-a", start: "2026-06-16", end: "2026-06-18" },
    ]);
  });

  it("splits a run that a complete point interrupts", () => {
    // Two outages are two repairs, so one covered day in the middle ends the
    // first range rather than being swallowed by it.
    const ranges = foldIncompleteData([
      { date: "2026-06-16", unpricedSecurityIds: ["sec-a"] },
      { date: "2026-06-17" },
      { date: "2026-06-18", unpricedSecurityIds: ["sec-a"] },
    ]);
    expect(ranges.prices).toEqual([
      { key: "sec-a", start: "2026-06-16", end: "2026-06-16" },
      { key: "sec-a", start: "2026-06-18", end: "2026-06-18" },
    ]);
  });

  it("keeps each key, and each cause, on its own range", () => {
    const ranges = foldIncompleteData([
      {
        date: "2026-06-16",
        unpricedSecurityIds: ["sec-a", "sec-b"],
        missingRatePairs: ["USD->PLN"],
        unknownCashAccountIds: ["acc-1"],
      },
      { date: "2026-06-17", unpricedSecurityIds: ["sec-b"] },
    ]);
    expect(ranges.prices).toEqual([
      { key: "sec-a", start: "2026-06-16", end: "2026-06-16" },
      { key: "sec-b", start: "2026-06-16", end: "2026-06-17" },
    ]);
    expect(ranges.rates).toEqual([
      { key: "USD->PLN", start: "2026-06-16", end: "2026-06-16" },
    ]);
    expect(ranges.cash).toEqual([
      { key: "acc-1", start: "2026-06-16", end: "2026-06-16" },
    ]);
    expect(hasIncompleteData(ranges)).toBe(true);
  });

  it("folds by position in the series, not by calendar adjacency", () => {
    // A monthly series' points are a month apart and still consecutive.
    const ranges = foldIncompleteData([
      { date: "2026-01-01", missingRatePairs: ["USD->PLN"] },
      { date: "2026-02-01", missingRatePairs: ["USD->PLN"] },
      { date: "2026-03-01", missingRatePairs: ["USD->PLN"] },
    ]);
    expect(ranges.rates).toEqual([
      { key: "USD->PLN", start: "2026-01-01", end: "2026-03-01" },
    ]);
  });

  it("closes a range that runs to the last point", () => {
    const ranges = foldIncompleteData([
      { date: "2026-06-16" },
      { date: "2026-06-17", unknownCashAccountIds: ["acc-1"] },
    ]);
    expect(ranges.cash).toEqual([
      { key: "acc-1", start: "2026-06-17", end: "2026-06-17" },
    ]);
  });

  it("is empty for an empty series", () => {
    expect(foldIncompleteData([])).toEqual(EMPTY_INCOMPLETE_RANGES);
  });

  it("keeps the newest runs when a cause has more than the bound", () => {
    // Every other day missing for one security: 4 points make 2 runs, so 2n
    // points make n runs. Ask for three and the three most recent come back,
    // still oldest-first, with the flag saying the list is a tail.
    const points = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      unpricedSecurityIds: i % 2 === 0 ? ["sec-a"] : [],
    }));
    const ranges = foldIncompleteData(points, 3);
    expect(ranges.prices).toEqual([
      { key: "sec-a", start: "2026-06-05", end: "2026-06-05" },
      { key: "sec-a", start: "2026-06-07", end: "2026-06-07" },
      { key: "sec-a", start: "2026-06-09", end: "2026-06-09" },
    ]);
    expect(ranges.truncated).toEqual({
      prices: true,
      rates: false,
      cash: false,
    });
  });

  it("bounds each cause at fifty runs by default", () => {
    const points = Array.from({ length: 200 }, (_, i) => ({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      missingRatePairs: i % 2 === 0 ? ["USD->PLN"] : [],
    }));
    const ranges = foldIncompleteData(points);
    expect(ranges.rates).toHaveLength(MAX_INCOMPLETE_RANGES_PER_CAUSE);
    expect(ranges.truncated.rates).toBe(true);
  });
});
