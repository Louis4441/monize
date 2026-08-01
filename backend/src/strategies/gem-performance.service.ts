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
  GemCurrentPortfolioSimulation,
  GemPerformancePoint,
  GemPerformanceView,
  GemRange,
} from "./gem-report.types";

/** One security the accounts hold now, as the simulation needs it. */
export interface GemSimulationHolding {
  securityId: string | null;
  symbol: string | null;
  /** Value today, in any one currency; null when it could not be priced. */
  marketValue: number | null;
  isCash: boolean;
}

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
    /** What the strategy accounts hold now, for the composition simulation. */
    holdings?: GemSimulationHolding[];
    asOf?: string;
  }): Promise<GemPerformanceView | null> {
    const { range, securityByRole } = params;
    const asOf = params.asOf ?? todayYMD();
    const securityIds = [...securityByRole.values()];
    if (securityIds.length === 0) return null;

    const from = this.windowStart(range, asOf);
    const sampling = rangeSampling(range);
    // The simulation reads the same window at the same sampling, so its
    // securities ride along on the one query rather than opening a second.
    const held = (params.holdings ?? []).filter(
      (holding) => !holding.isCash && holding.securityId !== null,
    );
    const series = await this.priceService.loadSeries(
      [
        ...new Set([
          ...securityIds,
          ...held.map((holding) => holding.securityId as string),
        ]),
      ],
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

    const currentPortfolio = this.simulateCurrentComposition({
      held,
      series,
      dates: orderedDates,
      expectedStart,
      sampling,
    });

    return { range, points, totals, incomplete, currentPortfolio };
  }

  /**
   * Today's holdings, in today's proportions, replayed over the window.
   *
   *   securityIndex_i(t) = P_i(t) / P_i(t0)
   *   portfolioIndex(t)  = sum(w_i * securityIndex_i(t))
   *   returnPercent(t)   = (portfolioIndex(t) - 1) * 100
   *
   * `w_i` is the holding's share of today's market value and is struck once, at
   * `t0`. Nothing rebalances it afterwards: the line is what buy-and-hold from
   * the start of the window would have done, which is what makes it comparable
   * with the single-instrument lines beside it. The prices are the same
   * adjusted closes those lines use, in each instrument's own listing currency,
   * so no FX movement enters either.
   *
   * Three ways it declines to answer, and it says which:
   *
   * - nothing is held, so there is no composition to simulate;
   * - a holding has no current value, so its weight is unknown -- and equal
   *   weights would be an invention, not a fallback;
   * - a holding has no usable price history, so it cannot be replayed. The
   *   others are *not* renormalised into a line without it: that is a
   *   different portfolio, and it would be read as this one.
   */
  private simulateCurrentComposition(params: {
    held: GemSimulationHolding[];
    series: Map<string, PricePoint[]>;
    dates: string[];
    expectedStart: string;
    sampling: "day" | "week" | "month";
  }): GemCurrentPortfolioSimulation | null {
    const { held, series, dates, expectedStart, sampling } = params;
    const empty = (
      unavailableReason: GemCurrentPortfolioSimulation["unavailableReason"],
    ): GemCurrentPortfolioSimulation => ({
      points: [],
      totalReturnPercent: null,
      completeRange: false,
      startsOn: null,
      includedHoldings: [],
      unavailableReason,
    });

    if (held.length === 0) return empty("NO_HOLDINGS");
    if (held.some((holding) => holding.marketValue === null)) {
      return empty("UNKNOWN_CURRENT_VALUE");
    }
    const total = held.reduce(
      (sum, holding) => sum + (holding.marketValue as number),
      0,
    );
    if (!(total > 0)) return empty("UNKNOWN_CURRENT_VALUE");

    const legs = held.map((holding) => ({
      securityId: holding.securityId as string,
      symbol: holding.symbol,
      weight: (holding.marketValue as number) / total,
      prices: series.get(holding.securityId as string) ?? [],
    }));
    if (
      legs.some((leg) => leg.prices.length === 0 || !(leg.prices[0].close > 0))
    ) {
      return empty("MISSING_PRICE_HISTORY");
    }

    // The simulation opens on the first date every leg can be priced on, and
    // never before the chart's own first point.
    //
    // Both bounds matter. A holding listed halfway through the window must not
    // be carried backwards at its own first close, which would draw a flat
    // stretch nobody held. And a holding whose history runs *deeper* than the
    // plotted window must not set the base off-chart: rebasing to 1976 while
    // the chart starts in 1993 opens the dashed line at +700% instead of 0%,
    // reports the wrong window's return, and stretches the y-axis until every
    // asset line beside it is flat.
    const firstPlotted = dates[0];
    const lastPlotted = dates[dates.length - 1];
    if (!firstPlotted) return empty("MISSING_PRICE_HISTORY");
    const startsOn = legs
      .map((leg) => leg.prices[0].date)
      .reduce((latest, date) => (date > latest ? date : latest), firstPlotted);
    // Listed after the last point the chart draws: there is no segment to
    // show, and saying so is the difference between an explained absence and a
    // legend entry for a line that is not there.
    if (startsOn > lastPlotted) return empty("MISSING_PRICE_HISTORY");
    const bases = legs.map((leg) => ({
      ...leg,
      base: priceAsOf(leg.prices, startsOn) as number,
    }));
    if (bases.some((leg) => !(leg.base > 0))) {
      return empty("MISSING_PRICE_HISTORY");
    }

    const points = dates.map((date) => {
      if (date < startsOn) return { date, returnPercent: null };
      let index = 0;
      for (const leg of bases) {
        const close = priceAsOf(leg.prices, date);
        if (close === null) return { date, returnPercent: null };
        index += leg.weight * (close / leg.base);
      }
      return {
        date,
        returnPercent: roundToDecimals((index - 1) * 100, GEM_PP_DECIMALS),
      };
    });

    const priced = points.filter((point) => point.returnPercent !== null);
    return {
      points,
      totalReturnPercent: priced[priced.length - 1]?.returnPercent ?? null,
      completeRange:
        startsOn <= addDays(expectedStart, COVERAGE_TOLERANCE_DAYS[sampling]),
      startsOn,
      includedHoldings: bases.map((leg) => ({
        securityId: leg.securityId,
        symbol: leg.symbol,
        weightPercent: roundToDecimals(leg.weight * 100, 2),
      })),
      unavailableReason: null,
    };
  }
}
