/**
 * Bond API shapes. They mirror the backend exactly
 * (`backend/src/bonds/bond-valuation.service.ts`,
 * `backend/src/bonds/engine/bond-engine-types.ts`, `backend/src/bonds/bond-lots.ts`).
 *
 * Money and rate fields are decimal STRINGS (a rate is a fraction, "0.0440" is
 * 4.40%) or null. Null means unknown, never zero: it is converted to a number
 * only at the formatting boundary, and only when it is not null.
 */

/** A catalog instrument a security can be linked to (`GET /bonds/instruments`). */
export interface BondInstrumentSummary {
  id: string;
  issuerCountryCode: string;
  issuerCode: string;
  programCode: string;
  seriesCode: string;
  currencyCode: string;
}

export type BondRateSource = 'TERMS' | 'ANNOUNCED' | 'DERIVED' | 'PROJECTED';

export type BondEarlyRedemptionRefusal =
  | 'NOT_REDEEMABLE'
  | 'TOO_EARLY'
  | 'TOO_LATE'
  | 'RECORD_DAY'
  | 'MATURED'
  | 'RATE_UNKNOWN'
  | 'TERMS_INCOMPLETE';

export interface BondCashFlow {
  date: string;
  type: 'INTEREST' | 'PRINCIPAL';
  /** The whole lot. */
  amount: string;
  status: 'KNOWN' | 'PROJECTED';
  period: number;
}

export interface BondMissingObservation {
  benchmarkId: string;
  /** `YYYY-MM` for a monthly series, the observation day for a step series. */
  observation: string;
  /** Null when the benchmark itself is not stored. */
  publisher: string | null;
}

/** A benchmark value assumed for every period that has not started. */
export interface BondProjectionAssumption {
  benchmarkId: string;
  /** The assumed value as a fraction, e.g. "0.0290". */
  value: string;
  basis: 'SUPPLIED' | 'LATEST_OBSERVATION';
  /** The YYYY-MM-DD or YYYY-MM the value came from; null when SUPPLIED. */
  observation: string | null;
}

export interface BondCurrentPeriod {
  index: number;
  start: string;
  end: string;
  /** A fraction: "0.0440" is 4.40%. */
  annualRate: string;
  rateSource: BondRateSource;
}

/** The terms' rate rule as stated; every rate is a fraction string. */
export interface BondRateRule {
  type: 'FIXED' | 'BENCHMARK_PLUS_SPREAD' | 'INFLATION_PLUS_MARGIN_AS_RATE';
  benchmarkId: string | null;
  /** FIXED only. */
  annualRate: string | null;
  firstPeriodRate: string | null;
  /** The margin or spread. */
  addend: string | null;
  benchmarkFloor: string | null;
}

export interface BondRateScheduleBenchmark {
  benchmarkId: string;
  /** The YYYY-MM-DD or YYYY-MM key the observation rule computed. */
  observation: string;
  /** Observed (or assumed, when PROJECTED); null when not published. */
  value: string | null;
  /** After the benchmark floor; null when `value` is null. */
  flooredValue: string | null;
}

/** One period of a lot; `benchmark` is null for a TERMS or ANNOUNCED period. */
export interface BondRateScheduleEntry {
  index: number;
  start: string;
  end: string;
  annualRate: string | null;
  rateSource: BondRateSource | null;
  benchmark: BondRateScheduleBenchmark | null;
  addend: string | null;
  /**
   * Interest of the period PER BOND (spec 13.2), 10 decimal places, split by the
   * components of the rate. All five are null when the period's rate, or any
   * earlier rate of a compounding bond, is unknown; a part that does not apply
   * is "0". Multiply by the lot quantity for the holding.
   */
  interest: string | null;
  fixedPart: string | null;
  benchmarkPart: string | null;
  addendPart: string | null;
  announcedPart: string | null;
}

export interface BondValuation {
  asOf: string;
  seriesCode: string;
  termsVersion: number;
  quantity: number;
  maturityDate: string;
  currentPeriod: BondCurrentPeriod | null;
  rateRule: BondRateRule;
  /** One entry per period of the lot. */
  rateSchedule: BondRateScheduleEntry[];
  /** Per bond: the base of the current period. */
  principal: string | null;
  /** Lot. */
  accruedInterest: string | null;
  /** Lot, before any early redemption penalty. */
  grossValue: string | null;
  earlyRedemptionValue: string | null;
  earlyRedemptionRefusal: BondEarlyRedemptionRefusal | null;
  knownCashflows: BondCashFlow[];
  projectedCashflows: BondCashFlow[];
  maturityValueKnown: string | null;
  maturityValueProjected: string | null;
  projectionAssumptions: BondProjectionAssumption[];
  dataCompleteness: {
    termsComplete: boolean;
    referenceDataComplete: boolean;
    earlyRedemptionTermsComplete: boolean;
  };
  missing: BondMissingObservation[];
  valuationComplete: boolean;
}

export interface BondLotValuation {
  purchaseDate: string;
  quantity: number;
  /** A transfer in with no linked leg: the real purchase date is unknown. */
  purchaseDateAssumed: boolean;
  valuation: BondValuation;
}

/** Each total is null unless every lot has the figure. */
export interface BondValuationTotals {
  quantity: number | null;
  grossValue: string | null;
  earlyRedemptionValue: string | null;
  accruedInterest: string | null;
}

export type BondLotsRefusalCode =
  | 'SPLIT'
  | 'FRACTIONAL_QUANTITY'
  | 'OVER_REMOVAL'
  | 'INVALID_QUANTITY';

export interface BondLotsRefusal {
  code: BondLotsRefusalCode;
  detail: string;
}

/** `GET /bonds/securities/:securityId/valuation`. */
export interface SecurityBondValuation {
  securityId: string;
  instrument: BondInstrumentSummary;
  asOf: string;
  lots: BondLotValuation[];
  totals: BondValuationTotals;
  refusal: BondLotsRefusal | null;
}

/** `POST /bonds/securities/:securityId/recompute`. */
export interface BondPriceRecompute {
  written: number;
  deleted: number;
}

/** One assumed benchmark value and the figures it gives over the open lots (spec 13.3). */
export interface BondScenario {
  /** The assumed value as sent, a fraction ("0.05" is 5%). */
  value: string;
  /** Each figure is a lot-summed amount, or null when any lot cannot be valued. */
  maturityValue: string | null;
  totalInterest: string | null;
  fixedInterest: string | null;
  benchmarkInterest: string | null;
  addendInterest: string | null;
  announcedInterest: string | null;
}

/** `GET /bonds/securities/:securityId/scenarios`. */
export interface SecurityBondScenarios {
  securityId: string;
  benchmarkId: string;
  asOf: string;
  /** Set when the lots cannot be derived; every figure is then null. */
  refusal: BondLotsRefusal | null;
  scenarios: BondScenario[];
}

/** A benchmark value assumed for the valuation, `assume=<benchmarkId>:<value>`. */
export interface BondAssumption {
  benchmarkId: string;
  /** A fraction string. */
  value: string;
}
