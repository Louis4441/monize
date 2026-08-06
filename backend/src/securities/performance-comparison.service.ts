import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { roundToDecimals } from "../common/round.util";
import { tr } from "../i18n/translate";
import {
  PRICE_WINDOW_LEAD_DAYS,
  PricePoint,
  addDays,
  daysBetween,
  observationAt,
  withLeadDays,
} from "../common/time-series/price-boundary.util";
import {
  LoadedPriceSeries,
  PriceSampling,
  loadPriceSeries,
} from "../common/time-series/price-series.util";
import { Security } from "./entities/security.entity";
import { MarketIndexService } from "./market-index.service";
import { marketIndexByCode } from "./market-indexes";
import {
  PerformanceComparisonView,
  PerformanceExclusion,
  PerformanceExclusionReason,
  PerformanceGap,
  PerformancePoint,
  PerformanceSeriesKind,
  PerformanceSeriesRef,
} from "./performance-comparison.types";

/** Percentage points, rounded the way every return figure in this app is. */
const PP_DECIMALS = 4;

/**
 * Sampling by window length. Daily closes are what the shorter windows are for;
 * over a decade they ship tens of thousands of points the chart cannot draw
 * distinctly.
 */
function samplingFor(start: string, end: string): PriceSampling {
  const days = daysBetween(start, end);
  if (days <= 400) return "day";
  if (days <= 1300) return "week";
  return "month";
}

/**
 * How stale an observation may be and still stand for a plotted date.
 *
 * Carrying a series forward between observations is deliberate: a market holiday
 * in one country must not punch a hole in the others' lines. Unbounded, the same
 * mechanism draws a delisted instrument as a perfectly flat line across every
 * month since its feed stopped, and reports the level it stopped at as the
 * window's return -- a stale quote wearing today's date.
 *
 * One sampling bucket plus a closed market. The same table answers the boundary
 * lookup at the window start, because a monthly series genuinely has no
 * observation within a fortnight of an arbitrary date and refusing on the daily
 * bound would exclude every series on a long window.
 */
const LAG_DAYS: Record<PriceSampling, number> = {
  day: 10,
  week: 21,
  month: 45,
};

export interface PerformanceComparisonRequest {
  securityIds: string[];
  indexCodes: string[];
  /** Omitted means "all history", resolved from the data (contract section 2.5). */
  startDate?: string;
  endDate?: string;
}

/** A candidate line, before we know whether it can be drawn. */
interface Candidate {
  key: string;
  kind: PerformanceSeriesKind;
  id: string;
  label: string;
  name: string;
  currencyCode: string;
}

/** A candidate that resolved a base, and can therefore be plotted. */
interface Resolved extends Candidate {
  points: PricePoint[];
  base: number;
  baseDate: string;
  basis: LoadedPriceSeries["basis"];
}

/**
 * The Security Performance report's comparison chart.
 *
 * Every line is a cumulative percent return rebased at the window's **start**,
 * so instruments with different price levels and currencies compare on one axis
 * and a benchmark can be read against a holding. A series that cannot be priced
 * at that boundary is refused with a reason rather than rebased on its own later
 * first observation, which would report the window's return measured from a date
 * the label does not mention.
 *
 * `docs/security-benchmark-comparison.md` is the specification; it carries the
 * exclusion truth table, the worked examples and the test matrix.
 */
@Injectable()
export class PerformanceComparisonService {
  constructor(
    private dataSource: DataSource,
    private marketIndexService: MarketIndexService,
  ) {}

  async getComparison(
    userId: string,
    request: PerformanceComparisonRequest,
  ): Promise<PerformanceComparisonView> {
    const securityIds = [...new Set(request.securityIds)];
    const indexCodes = [...new Set(request.indexCodes)].filter(
      (code) => marketIndexByCode(code) !== undefined,
    );

    // Ownership first, and under the caller's own scope: an id that is not
    // theirs must not reach a price query, let alone appear in the payload.
    const securities = await this.loadOwnedSecurities(userId, securityIds);

    const end = request.endDate ?? todayYMD();
    const start =
      request.startDate ??
      (await this.earliestDate(
        securities.map((s) => s.id),
        indexCodes,
      )) ??
      end;

    // The index history has to reach the window before it can be read. Failures
    // here leave the index unpriced, which the exclusion list then reports --
    // they are not allowed to take the securities' lines down with them.
    await this.marketIndexService.ensureHistory(indexCodes, start);

    const sampling = samplingFor(start, end);
    const lag = LAG_DAYS[sampling];
    // The lookup that prices the window's start searches backwards, so the read
    // must reach behind the boundary by at least what the rule will accept.
    const loadFrom = withLeadDays(start, Math.max(lag, PRICE_WINDOW_LEAD_DAYS));

    const [securitySeries, indexSeries] = await withScopedDb(
      this.dataSource,
      async (m: EntityManager) => [
        await loadPriceSeries(m, {
          table: "security_prices",
          ids: securities.map((s) => s.id),
          fromDate: loadFrom,
          toDate: end,
          sampling,
        }),
        await this.marketIndexService.loadSeries(
          indexCodes,
          loadFrom,
          end,
          sampling,
          m,
        ),
      ],
    );

    const candidates: Array<{
      candidate: Candidate;
      loaded: LoadedPriceSeries | undefined;
    }> = [
      ...securities
        .slice()
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((security) => ({
          candidate: {
            key: `sec:${security.id}`,
            kind: "SECURITY" as const,
            id: security.id,
            label: security.symbol,
            name: security.name,
            currencyCode: security.currencyCode,
          },
          loaded: securitySeries.get(security.id),
        })),
      // Benchmarks last, so the categorical palette assigns the same colour to
      // the same security whether or not an index is overlaid.
      ...indexCodes
        .map((code) => marketIndexByCode(code))
        .filter((index) => index !== undefined)
        .sort((a, b) => a.defaultName.localeCompare(b.defaultName))
        .map((index) => ({
          candidate: {
            key: `idx:${index.code}`,
            kind: "INDEX" as const,
            id: index.code,
            label: index.code,
            name: index.defaultName,
            currencyCode: index.currencyCode,
          },
          loaded: indexSeries.get(index.code),
        })),
    ];

    const resolved: Resolved[] = [];
    const excluded: PerformanceExclusion[] = [];

    for (const { candidate, loaded } of candidates) {
      const outcome = this.resolveBase(loaded, start, end, lag);
      if ("reason" in outcome) {
        excluded.push({
          key: candidate.key,
          kind: candidate.kind,
          id: candidate.id,
          label: candidate.label,
          reason: outcome.reason,
        });
        continue;
      }
      resolved.push({ ...candidate, ...outcome });
    }

    return this.build({ start, end, sampling, lag, resolved, excluded });
  }

  /**
   * The base close a series is rebased on, or the reason it has none.
   *
   * Four refusals, not one. They are answered differently by the reader -- "we
   * hold nothing for this" is a data gap to fill, "its history starts later" is
   * a window to widen, and collapsing them into an absent line tells them
   * neither.
   */
  private resolveBase(
    loaded: LoadedPriceSeries | undefined,
    start: string,
    end: string,
    lag: number,
  ):
    | {
        points: PricePoint[];
        base: number;
        baseDate: string;
        basis: LoadedPriceSeries["basis"];
      }
    | { reason: PerformanceExclusionReason } {
    const points = loaded?.points ?? [];
    if (points.length === 0) return { reason: "NO_PRICE_HISTORY" };

    const base = observationAt(points, start, lag);
    if (!base) return { reason: "NO_PRICE_AT_WINDOW_START" };
    if (!(base.close > 0)) return { reason: "NON_POSITIVE_BASE" };

    // Both ends of a short window can resolve to the same row, and the
    // arithmetic then returns exactly zero -- a hard 0% that counts itself as a
    // fully covered period (docs/time-series-contract.md section 2.3).
    const hasLater = points.some(
      (point) => point.date > base.date && point.date <= end,
    );
    if (!hasLater) return { reason: "SINGLE_OBSERVATION" };

    return {
      points,
      base: base.close,
      baseDate: base.date,
      basis: loaded?.basis ?? "RAW",
    };
  }

  /** Assemble the plotted points, totals, gaps and completeness. */
  private build(params: {
    start: string;
    end: string;
    sampling: PriceSampling;
    lag: number;
    resolved: Resolved[];
    excluded: PerformanceExclusion[];
  }): PerformanceComparisonView {
    const { start, end, sampling, lag, resolved, excluded } = params;

    const series: PerformanceSeriesRef[] = resolved.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      id: entry.id,
      label: entry.label,
      name: entry.name,
      currencyCode: entry.currencyCode,
      basis: entry.basis,
    }));

    // The window's own start and end are always plotted. The start because
    // every included series is rebased there, so they leave the axis together
    // at 0% and the reader can see the comparison is like for like; the end
    // because a series whose feed stopped has to be shown running out, and
    // without a sample there it simply ends at its last observation and reads
    // as a complete line.
    const dates = new Set<string>([start, end]);
    for (const entry of resolved) {
      for (const point of entry.points) {
        if (point.date > start && point.date <= end) dates.add(point.date);
      }
      // A stride longer than the carry bound is a stretch nobody observed, and
      // the plotted dates alone will not reveal it: where every series shares
      // the hole there is no sample inside it, so the line is drawn straight
      // across months of nothing. Section 2.4 of the time-series contract is
      // explicit that two boundaries say nothing about the interior -- so the
      // stride is measured and a sample planted just past the bound, where the
      // series evaluates to null and the line breaks.
      const walk = [{ date: start, close: entry.base }, ...entry.points];
      for (let i = 1; i < walk.length; i += 1) {
        const previous = walk[i - 1].date;
        const next = walk[i].date;
        if (next <= previous || daysBetween(previous, next) <= lag) continue;
        const breakDate = addDays(previous, lag + 1);
        if (breakDate > start && breakDate < next && breakDate <= end) {
          dates.add(breakDate);
        }
      }
    }
    const orderedDates = [...dates].sort();

    const points: PerformancePoint[] = orderedDates.map((date) => {
      const values: Record<string, number | null> = {};
      for (const entry of resolved) {
        const close = observationAt(entry.points, date, lag)?.close ?? null;
        values[entry.key] =
          close === null
            ? null
            : roundToDecimals((close / entry.base - 1) * 100, PP_DECIMALS);
      }
      return { date, values };
    });

    const gaps: PerformanceGap[] = [];
    for (const entry of resolved) {
      let openFrom: string | null = null;
      let openTo: string | null = null;
      for (const point of points) {
        if (point.values[entry.key] === null) {
          openFrom = openFrom ?? point.date;
          openTo = point.date;
        } else if (openFrom && openTo) {
          gaps.push({ key: entry.key, from: openFrom, to: openTo });
          openFrom = null;
          openTo = null;
        }
      }
      if (openFrom && openTo) {
        gaps.push({ key: entry.key, from: openFrom, to: openTo });
      }
    }

    const last = points[points.length - 1];
    const totals: Record<string, number | null> = {};
    for (const entry of resolved) {
      // The window's return, or nothing. A series whose feed stopped in March is
      // not up 20% over the year: it is up 20% to March and unknown since.
      totals[entry.key] = last?.values[entry.key] ?? null;
    }

    const status =
      excluded.length === 0 &&
      gaps.length === 0 &&
      resolved.length > 0 &&
      resolved.every((entry) => totals[entry.key] !== null)
        ? "complete"
        : "incomplete";

    return {
      window: { start, end },
      sampling,
      series,
      points: resolved.length === 0 ? [] : points,
      totals,
      gaps,
      excluded,
      status,
    };
  }

  /**
   * The securities the caller actually owns.
   *
   * A missing id is a `404` for the whole request rather than a quietly dropped
   * line: a chart that silently omits one of the instruments you asked for is a
   * chart you will read as complete.
   */
  private async loadOwnedSecurities(
    userId: string,
    securityIds: string[],
  ): Promise<Security[]> {
    if (securityIds.length === 0) return [];
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { userId, id: In(securityIds) },
      }),
    );
    if (securities.length !== securityIds.length) {
      throw new NotFoundException(
        tr(
          "errors.securities.selectionNotFound",
          "One or more of the selected securities could not be found",
        ),
      );
    }
    return securities;
  }

  /**
   * The earliest observation across the selection.
   *
   * "All time" is a request with no start date, and the answer to "when does the
   * data start" is a query, not a constant. A hardcoded epoch is wrong here
   * specifically because the series enumerates its own sample points from the
   * window: every sample between the epoch and the first real datum would be
   * materialized as an empty point, which is the defect
   * `docs/time-series-contract.md` section 2.5 records.
   */
  private async earliestDate(
    securityIds: string[],
    indexCodes: string[],
  ): Promise<string | null> {
    if (securityIds.length === 0 && indexCodes.length === 0) return null;
    const rows: Array<{ earliest: string | null }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT MIN(earliest)::text AS earliest FROM (
             SELECT MIN(price_date) AS earliest
               FROM security_prices
              WHERE security_id = ANY($1::uuid[])
             UNION ALL
             SELECT MIN(price_date) AS earliest
               FROM market_index_prices
              WHERE index_code = ANY($2::text[])
           ) starts`,
          [securityIds, indexCodes],
        ),
    );
    return rows[0]?.earliest ?? null;
  }
}
