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
      previousRole: null,
    },
    {
      effectiveFrom: "2024-07-01",
      targetRole: "US_EQUITY",
      targetSecurityId: "sec-spy",
      previousRole: "US_EQUITY",
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
    expect(result?.taxApplied).toBe(false);
    expect(result?.commissionApplied).toBe(false);
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
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
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
    expect(result?.taxApplied).toBe(true);
  });

  it("charges no tax on a switch out of a loss", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
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
    expect(result?.commissionApplied).toBe(true);
  });

  it("restarts the run after a period it could not price", () => {
    // Holding a gap flat is not a simplification: the switch out of it would
    // realize nothing, so no tax comes off, and every later period compounds
    // from a balance the simulation invented. The run therefore begins after
    // the last gap, and `from` says so.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-unpriced",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: "US_EQUITY",
          },
        ],
      }),
    );

    expect(result?.from).toBe("2024-07-01");
    expect(result?.to).toBe("2025-01-01");
    expect(result?.coveragePercent).toBe(50);
    // 110 -> 121 over half a year: ~21% annualised, and nothing from the gap.
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
  });

  it("reports a truncated run gross, whatever costs are configured", () => {
    // The run opens on 2024-04-01 because the period before it could not be
    // priced -- but the strategy was already invested then, in something the
    // simulation cannot see and at a price it does not know. Charging an
    // opening commission bills a trade that never happened, and dating the tax
    // basis to 2024-04-01 taxes the July switch on the gain since the restart
    // rather than since the real purchase. Both are inventions, so a truncated
    // run reports gross and says so.
    const periods: GemBacktestInput["periods"] = [
      {
        effectiveFrom: "2024-01-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-unpriced",
        previousRole: null,
      },
      {
        effectiveFrom: "2024-04-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: "US_EQUITY",
      },
      {
        effectiveFrom: "2024-07-01",
        targetRole: "EM_EQUITY",
        targetSecurityId: "sec-emim",
        previousRole: "US_EQUITY",
      },
    ];
    const seriesBySecurity = new Map([
      ["sec-spy", series({ "2024-04-01": 100, "2024-07-01": 200 })],
      ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
    ]);

    const taxed = runBacktest(
      input({ periods, seriesBySecurity, taxRatePercent: 20 }),
    );
    const gross = runBacktest(
      input({ periods, seriesBySecurity, taxRatePercent: null }),
    );

    expect(taxed?.from).toBe("2024-04-01");
    expect(taxed?.taxApplied).toBe(false);
    expect(taxed?.commissionApplied).toBe(false);
    // The doubling reaches the end intact: no tax came off the switch.
    expect(taxed?.cagrPercent).toBe(gross?.cagrPercent);
    expect(taxed?.coveragePercent).toBeCloseTo(66.67, 1);
  });

  it("has nothing to report when the most recent period is unpriced", () => {
    expect(
      runBacktest(
        input({
          periods: [
            {
              effectiveFrom: "2024-01-01",
              targetRole: "US_EQUITY",
              targetSecurityId: "sec-spy",
              previousRole: null,
            },
            {
              effectiveFrom: "2024-07-01",
              targetRole: "US_EQUITY",
              targetSecurityId: "sec-unpriced",
              previousRole: "US_EQUITY",
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("does not let one stale quote price both ends of a period", () => {
    // A security last quoted in January answers a lookup for July and one for
    // January the following year with the same number. That is not a period
    // that opened and closed level -- it is a period nobody priced, and it used
    // to count towards full coverage with a confident 0% return.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([["sec-spy", series({ "2024-01-01": 100 })]]),
      }),
    );

    expect(result).toBeNull();
  });

  it("prices a period that opens on a day the market was shut", () => {
    // The 1st is regularly a weekend or a holiday, so the close that prices it
    // is the one a few days earlier. Within a fortnight it stands for the
    // boundary; older than that it does not.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([
          [
            "sec-spy",
            series({
              "2023-12-28": 100, // last trading day before the period opens
              "2024-06-28": 110,
              "2024-12-30": 121,
            }),
          ],
        ]),
      }),
    );

    expect(result?.coveragePercent).toBe(100);
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
  });

  it("leaves commission out when the capital it applies to is unknown", () => {
    const result = runBacktest(
      input({ commissionAmount: 100, notional: null }),
    );

    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.taxApplied).toBe(false);
    expect(result?.commissionApplied).toBe(false);
  });

  it("reports tax and commission separately when only one could be applied", () => {
    // Both are configured, but the portfolio total is unknown -- which is what
    // happens whenever a single holding cannot be priced -- so the absolute
    // commission cannot be turned into a drag while the tax percentage still
    // can. Under one `netOfCosts` flag this came out true, and the report then
    // told the user the figures were net of estimated taxes *and commissions*.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        taxRatePercent: 20,
        commissionAmount: 100,
        notional: null,
      }),
    );

    expect(result?.taxApplied).toBe(true);
    expect(result?.commissionApplied).toBe(false);
    // The tax really did come off: 2.0 at the switch, less 20% of the gain.
    expect(result?.cagrPercent).toBeCloseTo(80, 0);
  });

  it("counts the periods whose asset beat the safe one", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: "US_EQUITY",
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

  it("has no hit rate when a simulated period cannot be compared", () => {
    // The safe asset stops being quoted halfway through. Counting only the
    // periods that could be checked answers a question nobody asked -- "of the
    // ones we could check, how many won" -- and prints the ratio beside a run
    // twice as long, under a denominator the reader cannot see.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([
          [
            "sec-spy",
            series({ "2024-01-01": 100, "2024-07-01": 110, "2025-01-01": 121 }),
          ],
          ["sec-ief", series({ "2024-01-01": 100, "2024-07-01": 101 })],
        ]),
        safeSecurityId: "sec-ief",
      }),
    );

    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.hitRatePercent).toBeNull();
  });

  it("has no hit rate without a safe asset to compare against", () => {
    expect(runBacktest(input())?.hitRatePercent).toBeNull();
  });

  it("simulates a single evaluation, whose period runs to asOf", () => {
    // One signal effective in January and an `asOf` of the following January
    // is a complete year: an entry price, an exit price and the daily path in
    // between. Requiring a second evaluation withheld the report from a
    // strategy that had simply not switched yet.
    const result = runBacktest(input({ periods: [input().periods[0]] }));

    expect(result).toMatchObject({ from: "2024-01-01", to: "2025-01-01" });
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.coveragePercent).toBe(100);
  });

  it("reports gross when the first period already had a predecessor", () => {
    // The history keeps the last 24 periods, so the oldest signal in hand is
    // usually not the strategy's first allocation. Opening a fresh position
    // there charges a purchase commission for a trade that never happened and
    // resets the tax basis to the edge of the visible window, so the switch
    // below would be taxed on the gain since that reset rather than since the
    // real purchase.
    const periods: GemBacktestInput["periods"] = [
      {
        effectiveFrom: "2024-01-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: "SAFE",
      },
      {
        effectiveFrom: "2024-07-01",
        targetRole: "EM_EQUITY",
        targetSecurityId: "sec-emim",
        previousRole: "US_EQUITY",
      },
    ];
    const seriesBySecurity = new Map([
      ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
      ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
    ]);

    const withCosts = runBacktest(
      input({
        periods,
        seriesBySecurity,
        taxRatePercent: 20,
        commissionAmount: 100,
        notional: 10_000,
      }),
    );
    const gross = runBacktest(input({ periods, seriesBySecurity }));

    // Every period is priced, so coverage is full and the run is not truncated
    // by prices -- the costs are dropped because of what came *before* it.
    expect(withCosts?.coveragePercent).toBe(100);
    expect(withCosts?.taxApplied).toBe(false);
    expect(withCosts?.commissionApplied).toBe(false);
    expect(withCosts?.cagrPercent).toBe(gross?.cagrPercent);
  });

  it("has nothing to report without an evaluation or any price", () => {
    expect(runBacktest(input({ periods: [] }))).toBeNull();
    expect(runBacktest(input({ seriesBySecurity: new Map() }))).toBeNull();
    // A signal that became effective today has no period behind it yet.
    expect(
      runBacktest(input({ periods: [input().periods[0]], asOf: "2024-01-01" })),
    ).toBeNull();
  });

  it("reports nothing when the gap is the last thing that happened", () => {
    // The second leg has no prices at all, so there is no unbroken stretch
    // ending at today. Reporting the first half as though it were the run
    // would date the figures to a window that has since moved on.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-unpriced",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 110 })],
        ]),
      }),
    );

    expect(result).toBeNull();
  });
});
