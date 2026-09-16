import {
  DatedRate,
  FX_MAX_RATE_AGE_DAYS,
  describeFxGap,
  resolveFxRate,
  resolveFxRateValue,
} from "./fx-rate-resolver";

/**
 * Issue #1390: a 285-day hole in `exchange_rates` was back-filled with a rate
 * first observed nine months *after* the valuation date, and four resolvers
 * disagreed about which rate a session should use. These are the rules that
 * replaced them; every row here fails on the previous behaviour.
 */
function lookupFrom(
  stored: Record<string, DatedRate[]>,
): (from: string, to: string) => DatedRate[] | undefined {
  return (from, to) => stored[`${from}->${to}`];
}

const TODAY = "2026-09-16";

describe("resolveFxRate", () => {
  describe("the policy table", () => {
    const cases: Array<{
      name: string;
      stored: Record<string, DatedRate[]>;
      from: string;
      to: string;
      onDate: string;
      expected: {
        status: string;
        rate: number | null;
        observedOn?: string | null;
        direction?: string | null;
        reason?: string | null;
      };
    }> = [
      {
        // The reported defect: the only stored EUR rate is dated June 2026 and
        // the valuation is March 2026. `findBestRate` used to return it.
        name: "a valuation that predates the whole history is unknown, not the earliest rate",
        stored: { "EUR->USD": [{ date: "2026-06-20", rate: 1.12 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-03-01",
        expected: { status: "unknown", rate: null, reason: "only_after_date" },
      },
      {
        name: "a rate 285 days older than the date is unknown, not carried forward",
        stored: { "EUR->USD": [{ date: "2025-09-05", rate: 1.1 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-17",
        expected: {
          status: "unknown",
          rate: null,
          reason: "stale_observation",
        },
      },
      {
        name: "an old direct observation does not block a fresh inverse one",
        stored: {
          "EUR->USD": [{ date: "2026-01-02", rate: 1.1 }],
          "USD->EUR": [{ date: "2026-06-15", rate: 0.8 }],
        },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-17",
        expected: {
          status: "resolved",
          rate: 1.25,
          observedOn: "2026-06-15",
          direction: "inverse",
        },
      },
      {
        name: "direct and inverse observed the same day: direct wins",
        stored: {
          "EUR->USD": [{ date: "2026-06-15", rate: 1.2 }],
          "USD->EUR": [{ date: "2026-06-15", rate: 0.8 }],
        },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-17",
        expected: {
          status: "resolved",
          rate: 1.2,
          observedOn: "2026-06-15",
          direction: "direct",
        },
      },
      {
        // 2026-06-19 is a Friday, 2026-06-22 the Monday after it.
        name: "Friday's rate stands for the Monday after it",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 1.15 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: {
          status: "resolved",
          rate: 1.15,
          observedOn: "2026-06-19",
          direction: "direct",
        },
      },
      {
        name: "a zero stored rate is absent, not a rate of zero",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 0 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: { status: "unknown", rate: null, reason: "no_observation" },
      },
      {
        name: "a negative stored rate is absent",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: -1.15 }] },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: { status: "unknown", rate: null, reason: "no_observation" },
      },
      {
        name: "equal codes resolve to 1",
        stored: {},
        from: "EUR",
        to: "EUR",
        onDate: "2026-06-22",
        expected: {
          status: "same_currency",
          rate: 1,
          observedOn: null,
          direction: "identity",
        },
      },
      {
        name: "a missing source code is unknown, never 1",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 1.15 }] },
        from: "",
        to: "USD",
        onDate: "2026-06-22",
        expected: {
          status: "unknown",
          rate: null,
          reason: "unknown_currency",
        },
      },
      {
        name: "a missing target code is unknown, never 1",
        stored: { "EUR->USD": [{ date: "2026-06-19", rate: 1.15 }] },
        from: "EUR",
        to: "",
        onDate: "2026-06-22",
        expected: {
          status: "unknown",
          rate: null,
          reason: "unknown_currency",
        },
      },
      {
        name: "a pair nobody ever observed is unknown",
        stored: {},
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: { status: "unknown", rate: null, reason: "no_observation" },
      },
      {
        name: "the newest admissible observation on or before the date wins",
        stored: {
          "EUR->USD": [
            { date: "2026-06-10", rate: 1.1 },
            { date: "2026-06-18", rate: 1.2 },
            { date: "2026-06-25", rate: 1.3 },
          ],
        },
        from: "EUR",
        to: "USD",
        onDate: "2026-06-22",
        expected: {
          status: "resolved",
          rate: 1.2,
          observedOn: "2026-06-18",
          direction: "direct",
        },
      },
    ];

    it.each(cases)("$name", ({ stored, from, to, onDate, expected }) => {
      const result = resolveFxRate(from, to, onDate, lookupFrom(stored), {
        today: TODAY,
      });
      expect(result.status).toBe(expected.status);
      if (expected.rate === null) expect(result.rate).toBeNull();
      else expect(result.rate).toBeCloseTo(expected.rate, 10);
      if (expected.observedOn !== undefined) {
        expect(result.observedOn).toBe(expected.observedOn);
      }
      if (expected.direction !== undefined) {
        expect(result.direction).toBe(expected.direction);
      }
      if (expected.reason !== undefined) {
        expect(result.reason).toBe(expected.reason);
      }
    });
  });

  it("never consults the history for equal codes", () => {
    const lookup = jest.fn();
    expect(
      resolveFxRate("EUR", "EUR", "2026-06-22", lookup, { today: TODAY }).rate,
    ).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("accepts an observation exactly on the age bound and refuses the day past it", () => {
    const onDate = "2026-06-22";
    const onTheBound = new Date(Date.parse(`${onDate}T00:00:00Z`));
    onTheBound.setUTCDate(onTheBound.getUTCDate() - FX_MAX_RATE_AGE_DAYS);
    const pastIt = new Date(onTheBound.getTime() - 86_400_000);
    const at = (d: Date) => d.toISOString().slice(0, 10);

    expect(
      resolveFxRate(
        "EUR",
        "USD",
        onDate,
        lookupFrom({ "EUR->USD": [{ date: at(onTheBound), rate: 1.1 }] }),
        { today: TODAY },
      ).rate,
    ).toBe(1.1);
    expect(
      resolveFxRate(
        "EUR",
        "USD",
        onDate,
        lookupFrom({ "EUR->USD": [{ date: at(pastIt), rate: 1.1 }] }),
        { today: TODAY },
      ),
    ).toMatchObject({ status: "unknown", reason: "stale_observation" });
  });

  it("clamps a future valuation date to today rather than refusing it", () => {
    const result = resolveFxRate(
      "EUR",
      "USD",
      "2099-01-01",
      lookupFrom({ "EUR->USD": [{ date: TODAY, rate: 1.17 }] }),
      { today: TODAY },
    );
    expect(result).toMatchObject({ rate: 1.17, observedOn: TODAY });
  });

  describe("live mode", () => {
    it("takes the freshest observation rather than one on or before the date", () => {
      const result = resolveFxRate(
        "EUR",
        "USD",
        "2026-09-01",
        lookupFrom({
          "EUR->USD": [
            { date: "2026-09-01", rate: 1.1 },
            { date: "2026-09-15", rate: 1.2 },
          ],
        }),
        { mode: "live", today: TODAY },
      );
      expect(result).toMatchObject({ rate: 1.2, observedOn: "2026-09-15" });
    });

    it("is still bounded by the same age limit", () => {
      const result = resolveFxRate(
        "EUR",
        "USD",
        TODAY,
        lookupFrom({ "EUR->USD": [{ date: "2025-09-05", rate: 1.1 }] }),
        { mode: "live", today: TODAY },
      );
      expect(result).toMatchObject({
        status: "unknown",
        reason: "stale_observation",
      });
    });
  });

  it("does not depend on the order observations arrive in", () => {
    const ascending: DatedRate[] = [
      { date: "2026-06-10", rate: 1.1 },
      { date: "2026-06-18", rate: 1.2 },
    ];
    const descending = [...ascending].reverse();
    const at = (rows: DatedRate[]) =>
      resolveFxRate(
        "EUR",
        "USD",
        "2026-06-22",
        lookupFrom({ "EUR->USD": rows }),
        {
          today: TODAY,
        },
      );
    expect(at(descending)).toEqual(at(ascending));
  });

  it("resolveFxRateValue is the rate alone", () => {
    expect(
      resolveFxRateValue(
        "EUR",
        "USD",
        "2026-06-22",
        lookupFrom({ "EUR->USD": [{ date: "2026-06-18", rate: 1.2 }] }),
        { today: TODAY },
      ),
    ).toBe(1.2);
  });

  it("names each gap differently so a reader learns which repair applies", () => {
    const lines = (
      [
        "unknown_currency",
        "no_observation",
        "only_after_date",
        "stale_observation",
      ] as const
    ).map((reason) => describeFxGap("EUR->USD", "2026-03-01", reason));
    expect(new Set(lines).size).toBe(4);
    expect(lines.every((line) => line.includes("EUR->USD"))).toBe(true);
  });
});
