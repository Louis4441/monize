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

export interface BondCurrentPeriod {
  index: number;
  start: string;
  end: string;
  /** A fraction: "0.0440" is 4.40%. */
  annualRate: string;
  rateSource: BondRateSource;
}

export interface BondValuation {
  asOf: string;
  seriesCode: string;
  termsVersion: number;
  quantity: number;
  maturityDate: string;
  currentPeriod: BondCurrentPeriod | null;
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
  projectionAssumptions: string[];
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
