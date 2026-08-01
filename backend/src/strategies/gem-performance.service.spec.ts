import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { GemPerformanceService } from "./gem-performance.service";

describe("GemPerformanceService", () => {
  let service: GemPerformanceService;
  let priceService: { loadSeries: jest.Mock };

  const securityByRole = new Map<GemAssetRole, string>([
    ["US_EQUITY", "sec-spy"],
    ["EM_EQUITY", "sec-emim"],
  ]);

  beforeEach(() => {
    priceService = { loadSeries: jest.fn() };
    service = new GemPerformanceService(priceService as never);
  });

  const build = (overrides: Record<string, unknown> = {}) =>
    service.build({
      range: "1Y",
      securityByRole,
      asOf: "2025-08-14",
      ...overrides,
    } as never);

  it("rebases every asset to zero at the start of the window", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-14", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2024-08-14", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    const performance = await build();

    expect(performance?.points[0].values).toEqual({
      US_EQUITY: 0,
      EM_EQUITY: 0,
    });
    expect(performance?.totals).toEqual({ US_EQUITY: 15, EM_EQUITY: 30 });
    expect(performance?.incomplete).toBe(false);
    expect(performance?.range).toBe("1Y");
  });

  it("carries an asset forward over a date the other traded on", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2025-01-02", close: 100 },
            { date: "2025-01-03", close: 110 },
          ],
        ],
        ["sec-emim", [{ date: "2025-01-02", close: 50 }]],
      ]),
    );

    const performance = await build();

    expect(performance?.points.map((point) => point.date)).toEqual([
      "2025-01-02",
      "2025-01-03",
    ]);
    // The holiday date reuses the last known close rather than leaving a hole.
    expect(performance?.points[1].values.EM_EQUITY).toBe(0);
  });

  it("flags a window an asset does not cover", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-14", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
      ]),
    );

    const performance = await build();
    expect(performance?.incomplete).toBe(true);
    expect(performance?.totals.EM_EQUITY).toBeUndefined();
  });

  it("flags an asset that only starts mid-window", async () => {
    // A newly listed ETF is rebased to its own later start, so its line cannot
    // be read against a full-window series without the caveat.
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-14", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2025-02-03", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    const performance = await build();

    expect(performance?.incomplete).toBe(true);
    // The line is still drawn -- flagged, not dropped.
    expect(performance?.totals.EM_EQUITY).toBe(30);
  });

  it("tolerates a start a few days into the window", async () => {
    // The window opens on a day the market was shut; that is not a gap.
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-16", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2024-08-19", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    expect((await build())?.incomplete).toBe(false);
  });

  it("measures MAX coverage against the longest history, not a fixed date", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2005-01-31", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2005-02-28", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    // Both start in 2005, so neither is short against the other even though the
    // MAX window nominally reaches back to 1900.
    expect((await build({ range: "MAX" }))?.incomplete).toBe(false);
  });

  it("drops a series whose first close is not positive", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        ["sec-spy", [{ date: "2025-01-02", close: 0 }]],
        ["sec-emim", [{ date: "2025-01-02", close: 50 }]],
      ]),
    );

    const performance = await build();
    expect(performance?.totals.US_EQUITY).toBeUndefined();
    expect(performance?.incomplete).toBe(true);
  });

  it("is null when no asset has prices in the window", async () => {
    priceService.loadSeries.mockResolvedValue(new Map());
    await expect(build()).resolves.toBeNull();
  });

  it("is null with no instrument assigned at all", async () => {
    await expect(build({ securityByRole: new Map() })).resolves.toBeNull();
    expect(priceService.loadSeries).not.toHaveBeenCalled();
  });

  it("asks for the window and sampling the range implies", async () => {
    priceService.loadSeries.mockResolvedValue(new Map());

    await build({ range: "3M" });
    expect(priceService.loadSeries).toHaveBeenLastCalledWith(
      ["sec-spy", "sec-emim"],
      "2025-05-14",
      "day",
    );

    await build({ range: "5Y" });
    expect(priceService.loadSeries).toHaveBeenLastCalledWith(
      ["sec-spy", "sec-emim"],
      "2020-08-14",
      "month",
    );

    await build({ range: "MAX" });
    expect(priceService.loadSeries).toHaveBeenLastCalledWith(
      ["sec-spy", "sec-emim"],
      "1900-01-01",
      "month",
    );
  });

  describe("today's composition, simulated", () => {
    /** Two funds and a cash balance, priced today and over the window. */
    const twoHoldings = (): Array<{
      securityId: string | null;
      symbol: string | null;
      marketValue: number | null;
      isCash: boolean;
    }> => {
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          [
            "sec-emim",
            [
              { date: "2024-08-14", close: 50 },
              { date: "2025-08-14", close: 55 },
            ],
          ],
        ]),
      );
      return [
        {
          securityId: "sec-spy",
          symbol: "SPY",
          marketValue: 7500,
          isCash: false,
        },
        {
          securityId: "sec-emim",
          symbol: "EMIM",
          marketValue: 2500,
          isCash: false,
        },
        {
          securityId: null,
          symbol: null,
          marketValue: 4000,
          isCash: true,
        },
      ];
    };

    it("holds today's weights fixed from the start of the window", async () => {
      // 75% of a fund up 20% and 25% of one up 10%: 0.75*1.2 + 0.25*1.1 =
      // 1.175. Fixed weights, struck once -- rebalancing back to 75/25 along
      // the way would be a different strategy, and one nobody ran.
      const performance = await build({ holdings: twoHoldings() });
      const simulation = performance?.currentPortfolio;

      expect(simulation?.unavailableReason).toBeNull();
      expect(simulation?.points[0]).toEqual({
        date: "2024-08-14",
        returnPercent: 0,
      });
      expect(simulation?.totalReturnPercent).toBeCloseTo(17.5, 4);
      expect(simulation?.completeRange).toBe(true);
      expect(simulation?.startsOn).toBe("2024-08-14");
    });

    it("weights by market value and leaves cash out of both ends", async () => {
      const performance = await build({ holdings: twoHoldings() });

      // 7500 and 2500 of securities: 75/25. The 4000 of cash is neither a
      // weight nor a line -- it has no price history to replay.
      expect(performance?.currentPortfolio?.includedHoldings).toEqual([
        { securityId: "sec-spy", symbol: "SPY", weightPercent: 75 },
        { securityId: "sec-emim", symbol: "EMIM", weightPercent: 25 },
      ]);
    });

    it("starts later, and says so, when a holding is younger than the window", async () => {
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-02-14", close: 110 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          [
            // Listed halfway through the window.
            "sec-new",
            [
              { date: "2025-02-14", close: 10 },
              { date: "2025-08-14", close: 12 },
            ],
          ],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-spy",
              symbol: "SPY",
              marketValue: 5000,
              isCash: false,
            },
            {
              securityId: "sec-new",
              symbol: "NEW",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.startsOn).toBe("2025-02-14");
      expect(simulation?.completeRange).toBe(false);
      // Nothing is drawn before every leg can be priced: half a portfolio
      // carried backwards would be a line nobody held.
      expect(simulation?.points[0]).toEqual({
        date: "2024-08-14",
        returnPercent: null,
      });
      // 0.5 * (120/110) + 0.5 * (12/10) = 1.1454...
      expect(simulation?.totalReturnPercent).toBeCloseTo(14.55, 1);
    });

    it("reports nothing rather than a partial portfolio", async () => {
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          [
            "sec-emim",
            [
              { date: "2024-08-14", close: 50 },
              { date: "2025-08-14", close: 55 },
            ],
          ],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-spy",
              symbol: "SPY",
              marketValue: 5000,
              isCash: false,
            },
            // Never priced: the remaining fund is a different portfolio, and
            // the line would be read as this one.
            {
              securityId: "sec-unpriced",
              symbol: "XYZ",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("MISSING_PRICE_HISTORY");
      expect(simulation?.points).toEqual([]);
    });

    it("will not infer equal weights from an unknown value", async () => {
      const holdings = twoHoldings();
      holdings[1].marketValue = null;

      const simulation = (await build({ holdings }))?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("UNKNOWN_CURRENT_VALUE");
      expect(simulation?.totalReturnPercent).toBeNull();
    });

    it("says there is nothing to simulate for empty accounts", async () => {
      twoHoldings();
      const simulation = (await build({ holdings: [] }))?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("NO_HOLDINGS");
    });

    it("prices the simulation from the same adjusted series as the asset lines", async () => {
      // One query, one basis. A second read could disagree with the lines the
      // simulation is drawn beside -- and `loadSeries` is the only place the
      // adjusted-close fallback lives.
      const holdings = twoHoldings();
      await build({ holdings });

      expect(priceService.loadSeries).toHaveBeenCalledTimes(1);
      const [ids] = priceService.loadSeries.mock.calls[0];
      expect([...ids].sort()).toEqual(["sec-emim", "sec-spy"]);
    });
  });

});
