import {
  ForecastScheduleInput,
  accumulateForecastDeltas,
  addDaysYMD,
  buildForecastSeries,
} from "./balance-forecast.util";

function schedule(
  overrides: Partial<ForecastScheduleInput> = {},
): ForecastScheduleInput {
  return {
    id: "st-1",
    name: "Rent",
    accountId: "acc-1",
    transferAccountId: null,
    amount: -100,
    frequency: "MONTHLY",
    nextDueDate: "2024-07-15",
    endDate: null,
    occurrencesRemaining: null,
    ...overrides,
  };
}

/** The deltas alone, for the cases that are not about gaps. */
function deltasOf(
  schedules: ForecastScheduleInput[],
  accountId: string,
  today: string,
  horizon: string,
  actuals?: Map<string, number>,
): Map<string, number> {
  const { byDate, gaps } = accumulateForecastDeltas(
    schedules,
    accountId,
    today,
    horizon,
    actuals,
  );
  expect(gaps).toEqual([]);
  return byDate;
}

describe("balance-forecast.util", () => {
  describe("addDaysYMD", () => {
    it("adds days across month boundaries", () => {
      expect(addDaysYMD("2024-07-08", 90)).toBe("2024-10-06");
      expect(addDaysYMD("2024-12-31", 1)).toBe("2025-01-01");
    });
  });

  describe("accumulateForecastDeltas", () => {
    const today = "2024-07-08";
    const horizon = "2024-10-08";

    it("expands recurring occurrences within the horizon", () => {
      const deltas = deltasOf([schedule()], "acc-1", today, horizon);
      // MONTHLY from 2024-07-15: Jul 15, Aug 15, Sep 15 (Oct 15 is past horizon).
      expect([...deltas.keys()].sort()).toEqual([
        "2024-07-15",
        "2024-08-15",
        "2024-09-15",
      ]);
      expect(deltas.get("2024-08-15")).toBe(-100);
    });

    it("treats a transfer target as an inflow", () => {
      const s = schedule({
        accountId: "other",
        transferAccountId: "acc-1",
        amount: -250,
      });
      const deltas = deltasOf([s], "acc-1", today, horizon);
      expect(deltas.get("2024-07-15")).toBe(250);
    });

    it("stops a ONCE schedule after one occurrence", () => {
      const deltas = deltasOf(
        [schedule({ frequency: "ONCE" })],
        "acc-1",
        today,
        horizon,
      );
      expect([...deltas.keys()]).toEqual(["2024-07-15"]);
    });

    it("respects the end date and remaining occurrences", () => {
      const capped = deltasOf(
        [schedule({ occurrencesRemaining: 2 })],
        "acc-1",
        today,
        horizon,
      );
      expect([...capped.keys()].sort()).toEqual(["2024-07-15", "2024-08-15"]);

      const ended = deltasOf(
        [schedule({ endDate: "2024-08-31" })],
        "acc-1",
        today,
        horizon,
      );
      expect([...ended.keys()].sort()).toEqual(["2024-07-15", "2024-08-15"]);
    });

    it("skips occurrences on or before today and merges with actuals", () => {
      const actuals = new Map([["2024-07-20", 500]]);
      const deltas = deltasOf(
        [schedule({ nextDueDate: "2024-07-01" })], // starts in the past
        "acc-1",
        today,
        horizon,
        actuals,
      );
      // The 2024-07-01 occurrence is <= today, so it is not added.
      expect(deltas.has("2024-07-01")).toBe(false);
      expect(deltas.get("2024-07-20")).toBe(500);
      expect(deltas.get("2024-08-01")).toBe(-100);
    });

    // ---- Overrides and gaps (issue #1247) ----

    it("moves an overridden occurrence to its new date and amount", () => {
      const deltas = deltasOf(
        [
          schedule({
            overrides: [
              {
                originalDate: "2024-08-15",
                overrideDate: "2024-08-20",
                amount: -250,
              },
            ],
          }),
        ],
        "acc-1",
        today,
        horizon,
      );

      // August lands on the 20th at the override's amount; the other
      // occurrences are untouched.
      expect(deltas.has("2024-08-15")).toBe(false);
      expect(deltas.get("2024-08-20")).toBe(-250);
      expect(deltas.get("2024-07-15")).toBe(-100);
      expect(deltas.get("2024-09-15")).toBe(-100);
    });

    it("applies the transfer sign to an override too", () => {
      const deltas = deltasOf(
        [
          schedule({
            accountId: "other",
            transferAccountId: "acc-1",
            amount: -100,
            overrides: [
              {
                originalDate: "2024-07-15",
                overrideDate: "2024-07-15",
                amount: -400,
              },
            ],
          }),
        ],
        "acc-1",
        today,
        horizon,
      );

      expect(deltas.get("2024-07-15")).toBe(400);
    });

    it("drops an occurrence an override moved past the horizon", () => {
      const { byDate } = accumulateForecastDeltas(
        [
          schedule({
            frequency: "ONCE",
            overrides: [
              {
                originalDate: "2024-07-15",
                overrideDate: "2025-01-15",
                amount: -100,
              },
            ],
          }),
        ],
        "acc-1",
        today,
        horizon,
      );

      expect([...byDate.keys()]).toEqual([]);
    });

    it("reports an unpriced occurrence as a gap instead of skipping it", () => {
      const { byDate, gaps } = accumulateForecastDeltas(
        [
          schedule({
            id: "st-inv",
            name: "Monthly ETF buy",
            amount: null,
            gapReason: "unresolvedSettlementRate",
            gapFromCurrency: "USD",
            gapToCurrency: "CAD",
          }),
        ],
        "acc-1",
        today,
        horizon,
      );

      // Nothing is added -- an unknown amount is not a zero.
      expect([...byDate.keys()]).toEqual([]);
      expect(gaps).toEqual([
        {
          scheduledTransactionId: "st-inv",
          name: "Monthly ETF buy",
          reason: "unresolvedSettlementRate",
          fromCurrency: "USD",
          toCurrency: "CAD",
        },
      ]);
    });

    it("reports one gap per schedule, not one per occurrence", () => {
      const { gaps } = accumulateForecastDeltas(
        [schedule({ amount: null })],
        "acc-1",
        today,
        horizon,
      );

      // Three occurrences fall in the window; the reader needs the schedule once.
      expect(gaps).toHaveLength(1);
    });

    it("does not report a schedule whose unpriced occurrences all fall outside the horizon", () => {
      // Completeness is a question about THIS window: a schedule nobody can
      // price but which posts nothing before the horizon does not make this
      // projection unknown.
      const { byDate, gaps } = accumulateForecastDeltas(
        [
          schedule({
            amount: null,
            frequency: "ONCE",
            nextDueDate: "2025-06-01",
          }),
        ],
        "acc-1",
        today,
        horizon,
      );

      expect(gaps).toEqual([]);
      expect([...byDate.keys()]).toEqual([]);
    });

    it("does not report a schedule that does not touch this account", () => {
      const { gaps } = accumulateForecastDeltas(
        [schedule({ accountId: "other", amount: null })],
        "acc-1",
        today,
        horizon,
      );

      expect(gaps).toEqual([]);
    });

    it("reports an unpriced override even when the base amount is known", () => {
      const { byDate, gaps } = accumulateForecastDeltas(
        [
          schedule({
            overrides: [
              {
                originalDate: "2024-08-15",
                overrideDate: "2024-08-15",
                amount: null,
              },
            ],
          }),
        ],
        "acc-1",
        today,
        horizon,
      );

      expect(gaps).toHaveLength(1);
      // The occurrence contributes nothing rather than falling back to the base.
      expect(byDate.has("2024-08-15")).toBe(false);
      expect(byDate.get("2024-07-15")).toBe(-100);
    });
  });

  describe("buildForecastSeries", () => {
    it("anchors at today and accumulates deltas", () => {
      const deltas = new Map([
        ["2024-07-15", -100],
        ["2024-08-15", -100],
      ]);
      const series = buildForecastSeries(
        1000,
        "2024-07-08",
        "2024-10-08",
        deltas,
      );
      expect(series).toEqual([
        { date: "2024-07-08", balance: 1000 },
        { date: "2024-07-15", balance: 900 },
        { date: "2024-08-15", balance: 800 },
      ]);
    });

    it("returns just the anchor when there are no future deltas", () => {
      const series = buildForecastSeries(
        500,
        "2024-07-08",
        "2024-10-08",
        new Map(),
      );
      expect(series).toEqual([{ date: "2024-07-08", balance: 500 }]);
    });
  });
});
