import { Injectable } from "@nestjs/common";
import { roundToDecimals } from "../common/round.util";
import { todayYMD } from "../common/date-utils";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import {
  GEM_PP_DECIMALS,
  PricePoint,
  addMonthsUtc,
  parseYmd,
  priceAsOf,
} from "./gem-momentum.util";
import {
  GemPriceService,
  rangeMonths,
  rangeSampling,
} from "./gem-price.service";
import {
  GemPerformancePoint,
  GemPerformanceView,
  GemRange,
} from "./gem-report.types";

/** The earliest date any price series is allowed to start from, for MAX. */
const MAX_RANGE_START = "1900-01-01";

/**
 * How far after the window start a series may begin before it counts as not
 * covering the window. Generous enough to absorb the sampling bucket and a
 * closed market at the window edge, tight enough to catch an ETF that simply
 * did not exist yet.
 */
const COVERAGE_TOLERANCE_DAYS: Record<"day" | "week" | "month", number> = {
  day: 10,
  week: 21,
  month: 45,
};

/** ISO date `days` after `date`. */
function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Builds the report's asset-performance series: every strategy asset rebased to
 * zero at the start of the window, so instruments with different price levels
 * and currencies compare on one axis.
 */
@Injectable()
export class GemPerformanceService {
  constructor(private priceService: GemPriceService) {}

  /** First date of the window, or the epoch floor for MAX. */
  private windowStart(range: GemRange, asOf: string): string {
    const months = rangeMonths(range);
    if (months === null) return MAX_RANGE_START;
    return addMonthsUtc(parseYmd(asOf), -months).toISOString().slice(0, 10);
  }

  /**
   * Rebase one series to its first observation in the window. Returns null when
   * the series has no usable base (no prices in range, or a non-positive first
   * close), which the caller reports as an asset with no data rather than a flat
   * zero line.
   */
  private rebase(
    prices: PricePoint[],
  ): ((date: string) => number | null) | null {
    if (prices.length === 0) return null;
    const base = prices[0].close;
    if (!(base > 0)) return null;
    return (date: string) => {
      const close = priceAsOf(prices, date);
      if (close === null) return null;
      return roundToDecimals((close / base - 1) * 100, GEM_PP_DECIMALS);
    };
  }

  /**
   * One point per observation date across all assets, each asset carried forward
   * from its last known close so a market holiday in one country does not punch
   * a hole in the others' lines.
   */
  async build(params: {
    range: GemRange;
    /** Role -> securityId for mapped roles only. */
    securityByRole: Map<GemAssetRole, string>;
    asOf?: string;
  }): Promise<GemPerformanceView | null> {
    const { range, securityByRole } = params;
    const asOf = params.asOf ?? todayYMD();
    const securityIds = [...securityByRole.values()];
    if (securityIds.length === 0) return null;

    const from = this.windowStart(range, asOf);
    const sampling = rangeSampling(range);
    const series = await this.priceService.loadSeries(
      securityIds,
      from,
      sampling,
    );

    const readers = new Map<GemAssetRole, (date: string) => number | null>();
    const dates = new Set<string>();
    const starts: string[] = [];
    let incomplete = false;

    for (const [role, securityId] of securityByRole) {
      const prices = series.get(securityId) ?? [];
      const reader = this.rebase(prices);
      if (!reader) {
        incomplete = true;
        continue;
      }
      readers.set(role, reader);
      starts.push(prices[0].date);
      for (const point of prices) dates.add(point.date);
    }

    if (readers.size === 0) return null;
    // A role with no prices at all leaves the comparison a line short.
    if (readers.size < securityByRole.size) incomplete = true;
    // So does a series that only starts mid-window: it is rebased to its own
    // later start, so its line understates the window and cannot be read
    // against the others without the caveat. MAX has no fixed start, so there
    // the yardstick is the earliest series rather than the requested date.
    const expectedStart =
      rangeMonths(range) === null
        ? starts.reduce((earliest, date) => (date < earliest ? date : earliest))
        : from;
    const latestAcceptableStart = addDays(
      expectedStart,
      COVERAGE_TOLERANCE_DAYS[sampling],
    );
    if (starts.some((date) => date > latestAcceptableStart)) incomplete = true;

    const orderedDates = [...dates].sort();
    const points: GemPerformancePoint[] = orderedDates.map((date) => {
      const values: Partial<Record<GemAssetRole, number | null>> = {};
      for (const [role, reader] of readers) {
        values[role] = reader(date);
      }
      return { date, values };
    });

    const lastDate = orderedDates[orderedDates.length - 1];
    const totals: Partial<Record<GemAssetRole, number | null>> = {};
    for (const [role, reader] of readers) {
      totals[role] = reader(lastDate);
    }

    return { range, points, totals, incomplete };
  }
}
