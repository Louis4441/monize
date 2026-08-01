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
): GemStrategySignal =>
  ({
    effectiveFrom,
    targetRole: "US_EQUITY",
    targetSecurityId,
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
      netOfCosts: true,
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
      asOf: "2025-01-01",
    });

    expect(priceService.loadSeries.mock.calls[0][0].sort()).toEqual([
      "sec-ief",
      "sec-spy",
    ]);
  });

  it("has nothing to simulate from a single evaluation", async () => {
    const result = await service.build({
      strategy: strategy(),
      signals: [signal("2024-01-01", "sec-spy")],
      safeSecurityId: null,
      notional: null,
      asOf: "2025-01-01",
    });

    expect(result).toBeNull();
    expect(priceService.loadSeries).not.toHaveBeenCalled();
  });

  it("has nothing to simulate when no period named an instrument", async () => {
    const result = await service.build({
      strategy: strategy(),
      signals: [signal("2024-01-01", null), signal("2024-07-01", null)],
      safeSecurityId: null,
      notional: null,
      asOf: "2025-01-01",
    });

    expect(result).toBeNull();
    expect(priceService.loadSeries).not.toHaveBeenCalled();
  });
});
