import { BondErrorParams } from "../bond-errors";
import { BenchmarkData } from "../domain/benchmark";
import { BusinessDayCalendar } from "../domain/business-day-calendar";
import { BondTerms } from "../domain/bond-terms";

export type RateSource = "TERMS" | "ANNOUNCED" | "DERIVED" | "PROJECTED";

export type EarlyRedemptionRefusal =
  | "NOT_REDEEMABLE"
  | "TOO_EARLY"
  | "TOO_LATE"
  | "RECORD_DAY"
  | "MATURED"
  | "RATE_UNKNOWN"
  | "TERMS_INCOMPLETE";

export interface BondEngineInput {
  readonly terms: BondTerms;
  readonly termsVersion: number;
  /** Announced rate fractions by period number; an announced rate wins (spec 2.2). */
  readonly announcedRates: ReadonlyMap<number, string>;
  /** Stored observations by benchmark id; the caller loads them, the engine never fetches. */
  readonly benchmarks: ReadonlyMap<string, BenchmarkData>;
  /** Calendars by id (a `CalendarRegistry.asMap()`); an unknown id makes the terms incomplete. */
  readonly calendars: ReadonlyMap<string, BusinessDayCalendar>;
  readonly lot: { readonly purchaseDate: string; readonly quantity: number };
  readonly asOf: string;
  /** Benchmark value assumed for periods that have not started and have no data. */
  readonly projection?: ReadonlyMap<string, string>;
}

export interface MissingObservation {
  readonly benchmarkId: string;
  /** `YYYY-MM` for a monthly series, the observation day for a step series. */
  readonly observation: string;
  /** Null when the benchmark itself is absent from the input. */
  readonly publisher: string | null;
}

export interface CashFlow {
  readonly date: string;
  readonly type: "INTEREST" | "PRINCIPAL";
  /** The whole lot, 2 decimals. */
  readonly amount: string;
  readonly status: "KNOWN" | "PROJECTED";
  readonly period: number;
}

/** The terms' rate rule as stated, in plain fields; fractions are strings. */
export interface RateRuleDescription {
  readonly type:
    "FIXED" | "BENCHMARK_PLUS_SPREAD" | "INFLATION_PLUS_MARGIN_AS_RATE";
  readonly benchmarkId: string | null;
  /** FIXED only. */
  readonly annualRate: string | null;
  readonly firstPeriodRate: string | null;
  /** The margin or spread. */
  readonly addend: string | null;
  readonly benchmarkFloor: string | null;
}

export interface RateScheduleBenchmark {
  readonly benchmarkId: string;
  /** The YYYY-MM-DD or YYYY-MM key the observation rule computed. */
  readonly observation: string;
  /** Observed (or assumed, when PROJECTED); null when not published. */
  readonly value: string | null;
  /** After the benchmark floor; null when `value` is null. */
  readonly flooredValue: string | null;
}

export interface RateScheduleEntry {
  readonly index: number;
  readonly start: string;
  readonly end: string;
  readonly annualRate: string | null;
  readonly rateSource: RateSource | null;
  readonly benchmark: RateScheduleBenchmark | null;
  readonly addend: string | null;
  /**
   * Interest of the period per bond (spec 13.2), 10 decimal places, split by the
   * components of the rate. Each is null when the period's rate, or, for a
   * compounding bond, any earlier rate is unknown; a part that does not apply
   * is "0". `benchmarkPart + addendPart` equals `interest` for a benchmark period.
   */
  readonly interest: string | null;
  readonly fixedPart: string | null;
  readonly benchmarkPart: string | null;
  readonly addendPart: string | null;
  readonly announcedPart: string | null;
}

export interface BondValuation {
  readonly asOf: string;
  readonly seriesCode: string;
  readonly termsVersion: number;
  readonly quantity: number;
  readonly maturityDate: string;
  readonly currentPeriod: {
    readonly index: number;
    readonly start: string;
    readonly end: string;
    readonly annualRate: string;
    readonly rateSource: RateSource;
  } | null;
  readonly rateRule: RateRuleDescription;
  /** One entry per period of the lot. */
  readonly rateSchedule: readonly RateScheduleEntry[];
  /** Per bond: the base of the current period (the nominal for a coupon bond). */
  readonly principal: string | null;
  /** Lot: gross value less nominal (capitalised plus current accrual when compounding). */
  readonly accruedInterest: string | null;
  /** Lot, before any early redemption penalty. */
  readonly grossValue: string | null;
  readonly earlyRedemptionValue: string | null;
  readonly earlyRedemptionRefusal: EarlyRedemptionRefusal | null;
  /** Cash flows after `asOf`, every rate they depend on known. */
  readonly knownCashflows: readonly CashFlow[];
  readonly projectedCashflows: readonly CashFlow[];
  readonly maturityValueKnown: string | null;
  /** Set only when a projected rate is involved; null otherwise. */
  readonly maturityValueProjected: string | null;
  readonly projectionAssumptions: readonly ProjectionAssumption[];
  readonly dataCompleteness: {
    readonly termsComplete: boolean;
    readonly referenceDataComplete: boolean;
    readonly earlyRedemptionTermsComplete: boolean;
  };
  readonly missing: readonly MissingObservation[];
  readonly valuationComplete: boolean;
}

/**
 * A benchmark value assumed for every period that has not started. Structured,
 * never a sentence: the client composes the user-facing text from its catalog.
 */
export interface ProjectionAssumption {
  readonly benchmarkId: string;
  /** The assumed value as a fraction, e.g. "0.0290". */
  readonly value: string;
  readonly basis: "SUPPLIED" | "LATEST_OBSERVATION";
  /** The YYYY-MM-DD or YYYY-MM the value came from; null when SUPPLIED. */
  readonly observation: string | null;
}

export type BondEngineErrorCode =
  | "QUANTITY_INVALID"
  | "DATE_INVALID"
  | "AS_OF_BEFORE_PURCHASE"
  | "BENCHMARK_NOT_READ"
  | "DECIMAL_INVALID";

/**
 * The input or stored data is unusable. `code` and `params` are what a client is
 * told (translated by the controller); `message` is English for the logs only
 * and must never reach a user.
 */
export class BondEngineError extends Error {
  constructor(
    readonly code: BondEngineErrorCode,
    readonly params: BondErrorParams,
    message: string,
  ) {
    super(message);
    this.name = "BondEngineError";
  }
}
