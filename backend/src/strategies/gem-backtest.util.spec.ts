import { PricePoint } from "./gem-momentum.util";
import { GemBacktestInput, runBacktest } from "./gem-backtest.util";

/** A flat-then-stepped daily series: `closes` keyed by date. */
const series = (closes: Record<string, number>): PricePoint[] =>
  Object.entries(closes)
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));

const input = (
  overrides: Partial<GemBacktestInput> = {},
): GemBacktestInput => ({
  periods: [
    {
      effectiveFrom: "2024-01-01",
      targetRole: "US_EQUITY",
      targetSecurityId: "sec-spy",
    },
    {
      effectiveFrom: "2024-07-01",
      targetRole: "US_EQUITY",
      targetSecurityId: "sec-spy",
    },
  ],
  seriesBySecurity: new Map([
    [
      "sec-spy",
      series({ "2024-01-01": 100, "2024-07-01": 110, "2025-01-01": 121 }),
    ],
  ]),
  safeSecurityId: null,
  taxRatePercent: null,
  commissionAmount: null,
  notional: null,
  asOf: "2025-01-01",
  ...overrides,
});

describe("runBacktest", () => {
  it("compounds the periods into an annualized return", () => {
    // 100 -> 121 over the simulated span: ~21% a year. The assertions are to
    // within half a point because 2024 is a leap year and the annualization
    // divides by 365.25 days, which dilutes a 366-day run very slightly.
    const result = runBacktest(input());

    expect(result).toMatchObject({ from: "2024-01-01", to: "2025-01-01" });
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.netOfCosts).toBe(false);
  });

  it("reports the worst decline inside a period, not only at its ends", () => {
    // The period starts and ends level, but halves in between: a period-end
    // simulation would report no drawdown at all.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([
          [
            "sec-spy",
            series({
              "2024-01-01": 100,
              "2024-04-01": 50,
              "2024-07-01": 100,
              "2025-01-01": 100,
            }),
          ],
        ]),
      }),
    );

    expect(result?.maxDrawdownPercent).toBeCloseTo(-50, 1);
    expect(result?.cagrPercent).toBeCloseTo(0, 6);
  });

  it("charges tax on the gain realized when the instrument changes", () => {
    // Doubles in the first period, then switches: 100% of the gain is realized
    // and 20% of it is taxed away before the second leg starts.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        taxRatePercent: 20,
      }),
    );

    // Equity 2.0 at the switch, minus 20% of the 1.0 gain = 1.8 over one year.
    expect(result?.cagrPercent).toBeCloseTo(80, 0);
    expect(result?.netOfCosts).toBe(true);
  });

  it("charges no tax on a switch out of a loss", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 50 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        taxRatePercent: 20,
      }),
    );

    // A halving and nothing after it: exactly -50% over the year, untaxed.
    expect(result?.cagrPercent).toBeCloseTo(-50, 0);
  });

  it("turns the per-trade commission into a drag against the notional", () => {
    const result = runBacktest(
      input({ commissionAmount: 100, notional: 10_000 }),
    );

    // One trade at 1% of the notional: the run starts from 0.99.
    expect(result?.cagrPercent).toBeCloseTo(19.79, 0);
    expect(result?.netOfCosts).toBe(true);
  });

  it("leaves commission out when the capital it applies to is unknown", () => {
    const result = runBacktest(
      input({ commissionAmount: 100, notional: null }),
    );

    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.netOfCosts).toBe(false);
  });

  it("counts the periods whose asset beat the safe one", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
          },
        ],
        seriesBySecurity: new Map([
          [
            "sec-spy",
            series({ "2024-01-01": 100, "2024-07-01": 110, "2025-01-01": 100 }),
          ],
          [
            "sec-ief",
            series({ "2024-01-01": 100, "2024-07-01": 101, "2025-01-01": 105 }),
          ],
        ]),
        safeSecurityId: "sec-ief",
      }),
    );

    // Equities won the first period (+10% vs +1%) and lost the second.
    expect(result?.hitRatePercent).toBe(50);
  });

  it("has nothing to report without two evaluations or any price", () => {
    expect(runBacktest(input({ periods: [] }))).toBeNull();
    expect(runBacktest(input({ periods: [input().periods[0]] }))).toBeNull();
    expect(runBacktest(input({ seriesBySecurity: new Map() }))).toBeNull();
  });

  it("holds an unpriced period flat rather than compressing the timeline", () => {
    // The second leg has no prices at all. Its period still spans the calendar,
    // so the annualized figure is diluted by it instead of ignoring the time.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-unpriced",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 110 })],
        ]),
      }),
    );

    expect(result?.to).toBe("2025-01-01");
    // 10% earned in the first half, nothing in the second: 10% over the year.
    expect(result?.cagrPercent).toBeCloseTo(10, 0);
  });
});
