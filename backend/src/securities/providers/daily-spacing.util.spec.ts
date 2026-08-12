import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  CoarseSeriesError,
  MAX_DAILY_GAP_DAYS,
  MIN_BARS_FOR_SPACING_VERDICT,
  assertDailySeries,
  isCoarserThanDaily,
  medianGapDays,
} from "./daily-spacing.util";

/** `count` bars `stepDays` apart, starting from a fixed Monday. */
function series(count: number, stepDays: number): Date[] {
  const start = Date.UTC(2026, 0, 5); // a Monday
  return Array.from(
    { length: count },
    (_, i) => new Date(start + i * stepDays * 86_400_000),
  );
}

/** Trading days: one apart, with a three-day step over each weekend. */
function tradingDays(weeks: number): Date[] {
  const dates: Date[] = [];
  let cursor = Date.UTC(2026, 0, 5);
  for (let w = 0; w < weeks; w += 1) {
    for (let d = 0; d < 5; d += 1) {
      dates.push(new Date(cursor + d * 86_400_000));
    }
    cursor += 7 * 86_400_000;
  }
  return dates;
}

describe("medianGapDays", () => {
  it("returns null for fewer than two observations", () => {
    expect(medianGapDays([])).toBeNull();
    expect(medianGapDays(series(1, 1))).toBeNull();
  });

  it("reads a weekday series as one day apart despite the weekend steps", () => {
    expect(medianGapDays(tradingDays(6))).toBe(1);
  });

  /**
   * The median rather than the mean is the whole point: an exchange closed for
   * a fortnight must not make a daily series look weekly.
   */
  it("is unmoved by a single long closure", () => {
    const dates = tradingDays(6);
    const withGap = [
      ...dates,
      new Date(dates[dates.length - 1].getTime() + 21 * 86_400_000),
    ];
    expect(medianGapDays(withGap)).toBe(1);
  });

  it("does not care about input order", () => {
    const shuffled = [...tradingDays(4)].reverse();
    expect(medianGapDays(shuffled)).toBe(1);
  });
});

describe("isCoarserThanDaily", () => {
  it("accepts a daily series", () => {
    expect(isCoarserThanDaily(tradingDays(6))).toBe(false);
  });

  it("rejects weekly bars", () => {
    expect(isCoarserThanDaily(series(30, 7))).toBe(true);
  });

  /**
   * The case that motivated this: a long-range request answered with monthly
   * bars, written into a daily table where nothing downstream could tell.
   */
  it("rejects monthly bars", () => {
    expect(isCoarserThanDaily(series(72, 30))).toBe(true);
  });

  it("sits the threshold between a weekend step and a weekly bar", () => {
    expect(MAX_DAILY_GAP_DAYS).toBeGreaterThan(3);
    expect(MAX_DAILY_GAP_DAYS).toBeLessThan(7);
  });

  /**
   * A settlement pass over a short window, or a thinly traded instrument, can
   * return two or three bars whose spacing says more about which days were
   * holidays than about the series. Refusing those would break the ordinary
   * path to catch a case that is never that short.
   */
  it("declines to judge a sample too small to convict", () => {
    expect(
      isCoarserThanDaily(series(MIN_BARS_FOR_SPACING_VERDICT - 1, 30)),
    ).toBe(false);
    expect(isCoarserThanDaily(series(MIN_BARS_FOR_SPACING_VERDICT, 30))).toBe(
      true,
    );
  });
});

describe("assertDailySeries", () => {
  it("passes a daily series through", () => {
    expect(() => assertDailySeries("AAPL", tradingDays(6))).not.toThrow();
  });

  it("names the subject and the spacing it refused", () => {
    let caught: unknown;
    try {
      assertDailySeries("XGRO.TO", series(72, 30));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoarseSeriesError);
    const err = caught as CoarseSeriesError;
    expect(err.subject).toBe("XGRO.TO");
    expect(err.medianGap).toBe(30);
    expect(err.bars).toBe(72);
    expect(err.message).toContain("XGRO.TO");
    expect(err.message).toContain("30");
  });
});

/**
 * The rule this file exists for was already written down and already enforced
 * -- on `market_index_prices` only, by a private copy in `market-index.service`
 * that `security_prices` never got. One table refusing coarse payloads while
 * the other accepted them is precisely the shape of the bug, so a second
 * definition anywhere is the regression.
 */
describe("the spacing rule is defined once", () => {
  const securitiesDir = join(__dirname, "..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".spec.ts")
        ? [full]
        : [];
    });
  }

  it("has no second implementation of medianGapDays or the threshold", () => {
    const offenders = sourceFiles(securitiesDir)
      .filter((file) => !file.endsWith("daily-spacing.util.ts"))
      .filter((file) => {
        const src = readFileSync(file, "utf8");
        return (
          /function\s+medianGapDays/.test(src) ||
          /const\s+MAX_DAILY_GAP_DAYS\s*=/.test(src)
        );
      });
    expect(offenders).toEqual([]);
  });
});
