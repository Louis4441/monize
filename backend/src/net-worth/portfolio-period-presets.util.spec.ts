import {
  presetEarliestDate,
  presetWindowStart,
} from "./portfolio-period-presets.util";

describe("presetWindowStart", () => {
  /**
   * YTD is measured from the close of the previous year's last trading
   * session. Opening on 1 January measured from a holiday; the daily series
   * values 31 December from the latest close on or before it, so a weekend
   * year-end still carries the last session's close.
   */
  it("opens YTD on 31 December of the previous year", () => {
    expect(presetWindowStart("ytd", "2026-09-26")).toBe("2025-12-31");
    expect(presetWindowStart("ytd", "2026-01-01")).toBe("2025-12-31");
    expect(presetWindowStart("ytd", "2026-12-31")).toBe("2025-12-31");
  });

  it("loads YTD from the day it opens, not a day earlier", () => {
    expect(presetEarliestDate("ytd", "2026-09-26")).toBe("2025-12-31");
  });

  it("leaves the other presets' arithmetic alone", () => {
    expect(presetWindowStart("1d", "2026-09-26")).toBe("2026-09-26");
    expect(presetWindowStart("1w", "2026-09-26")).toBe("2026-09-19");
    expect(presetWindowStart("1y", "2026-09-26")).toBe("2025-09-26");
    expect(presetWindowStart("all", "2026-09-26")).toBeNull();
  });
});
