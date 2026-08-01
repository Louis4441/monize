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
});
