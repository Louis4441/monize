import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemBacktestService } from "./gem-backtest.service";

const strategy = (overrides: Partial<GemStrategy> = {}): GemStrategy =>
  ({
    id: "strategy-1",
    cadence: "MONTHLY",
    lookbackMonths: 12,
    taxRatePercent: 19,
    commissionAmount: 29.9,
    ...overrides,
  }) as GemStrategy;

const signal = (
  effectiveFrom: string,
  targetSecurityId: string | null,
  previousRole: string | null = null,
): GemStrategySignal =>
  ({
    effectiveFrom,
    targetRole: "US_EQUITY",
    targetSecurityId,
    previousRole,
  }) as GemStrategySignal;

describe("GemBacktestService", () => {
  let priceService: { loadSeries: jest.Mock };
  let service: GemBacktestService;

  beforeEach(() => {
    priceService = {
      loadSeries: jest.fn().mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              // A close at, or within days of, every period boundary. A series
              // with a six-month hole is not a priced run: the same stale
              // quote would answer both ends of a period.
              { date: "2023-12-29", close: 100 },
              { date: "2024-06-28", close: 105 },
              { date: "2024-12-31", close: 110 },
            ],
          ],
        ]),
      ),
    };
    service = new GemBacktestService(priceService as never);
  });

  it("simulates the stored evaluations and loads a lead window of prices", async () => {
    const result = await service.build({
      strategy: strategy(),
      signals: [
        signal("2024-07-01", "sec-spy"),
        signal("2024-01-01", "sec-spy"),
      ],
      safeSecurityId: null,
      notional: 10_000,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    // Signals arrive newest-first from the report; the simulation sorts them,
    // so the series is loaded from the oldest period, not the newest -- and
    // from a fortnight before it, because a period opening on a weekend or a
    // holiday is priced by the close before it, which `price_date >= from`
    // would otherwise leave out.
    expect(priceService.loadSeries).toHaveBeenCalledWith(
      ["sec-spy"],
      "2023-12-18",
      "day",
    );
    // Every boundary falls on a day the market was shut -- 1 January, 1 July --
    // and is priced by the close before it, which is what the lead window
    // fetched. Without it the first period read as unpriced.
    expect(result).toMatchObject({
      from: "2024-01-01",
      to: "2025-01-01",
      taxApplied: true,
      commissionApplied: true,
      coveragePercent: 100,
    });
  });

  it("includes the safe asset's prices for the hit-rate comparison", async () => {
    await service.build({
      strategy: strategy(),
      signals: [
        signal("2024-01-01", "sec-spy"),
        signal("2024-07-01", "sec-spy"),
      ],
      safeSecurityId: "sec-ief",
      notional: null,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(priceService.loadSeries.mock.calls[0][0].sort()).toEqual([
      "sec-ief",
      "sec-spy",
    ]);
  });

  it("simulates a strategy that has produced only one evaluation", async () => {
    // The period runs to `asOf`, not to the next signal, so one evaluation and
    // a month of prices is a complete month. Withholding the whole backtest
    // until a second evaluation exists kept it from precisely the users most
    // likely to open it -- and contradicted the promise that a strategy
    // configured last month reports a month.
    const result = await service.build({
      strategy: strategy(),
      signals: [signal("2024-01-01", "sec-spy")],
      safeSecurityId: null,
      notional: 10_000,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(result).toMatchObject({
      from: "2024-01-01",
      to: "2025-01-01",
      coveragePercent: 100,
      // A first allocation with nothing before it: the opening buy is real.
      taxApplied: true,
      commissionApplied: true,
    });
  });

  it("reports gross when the oldest retained signal already held something", async () => {
    // The history is bounded to the last 24 periods, so for any older strategy
    // the oldest signal here is not its first allocation. Its `previousRole`
    // says so, and without that the simulation charges a purchase commission
    // for a trade that never happened and dates the tax basis to the edge of
    // the visible window -- taxing a later switch on the gain since an
    // arbitrary reset.
    const result = await service.build({
      strategy: strategy(),
      signals: [
        signal("2024-01-01", "sec-spy", "SAFE"),
        signal("2024-07-01", "sec-spy", "US_EQUITY"),
      ],
      safeSecurityId: null,
      notional: 10_000,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(result).toMatchObject({
      from: "2024-01-01",
      coveragePercent: 100,
      taxApplied: false,
      commissionApplied: false,
    });
  });

  it("has nothing to simulate when no period named an instrument", async () => {
    const result = await service.build({
      strategy: strategy(),
      signals: [signal("2024-01-01", null), signal("2024-07-01", null)],
      safeSecurityId: null,
      notional: null,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(result).toBeNull();
    expect(priceService.loadSeries).not.toHaveBeenCalled();
  });
});
