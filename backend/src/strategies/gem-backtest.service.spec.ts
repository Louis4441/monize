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
              { date: "2024-01-01", close: 100 },
              { date: "2025-01-01", close: 110 },
            ],
          ],
        ]),
      ),
    };
    service = new GemBacktestService(priceService as never);
  });

  it("simulates the stored evaluations and loads prices from the first one", async () => {
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
    // so the series is loaded from the oldest period, not the newest.
    expect(priceService.loadSeries).toHaveBeenCalledWith(
      ["sec-spy"],
      "2024-01-01",
      "day",
    );
    expect(result).toMatchObject({
      from: "2024-01-01",
      to: "2025-01-01",
      netOfCosts: true,
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
