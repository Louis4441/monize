import { compareYMD, daysBetween, isValidYMD } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import { buildSchedule, SchedulePeriod } from "../domain/period-schedule";
import {
  baseAt,
  compounds,
  couponOf,
  maturityValue,
  nominalOf,
  roundMoney,
  valueAt,
} from "./accrual";
import {
  BondEngineError,
  BondEngineInput,
  BondLotStatus,
  BondValuation,
  BondValuationRefusal,
  CashFlow,
  EarlyRedemptionRefusal,
  MissingObservation,
  RateRuleDescription,
  RateScheduleEntry,
} from "./bond-engine-types";
import { attributeInterest } from "./attribution";
import {
  PeriodRate,
  RatePlan,
  RateResolution,
  planPeriodRates,
  ratesWithStarted,
  startedPeriods,
} from "./rate-resolution";
import {
  proceedsPerBond,
  referencedCalendarIds,
  windowRefusal,
} from "./redemption";

export * from "./bond-engine-types";

interface RateInputs {
  readonly prior: readonly ExactDecimal[];
  readonly rate: ExactDecimal;
}

/**
 * The rates the formulas of period `k` need, or null when one is unknown. A
 * compounding bond needs periods 1..k; a coupon bond only period k.
 */
function inputsFor(
  compounding: boolean,
  rates: readonly PeriodRate[],
  k: number,
): RateInputs | null {
  const current = rates[k - 1].rate;
  if (current === null) return null;
  if (!compounding) return { prior: [], rate: current };
  const prior: ExactDecimal[] = [];
  for (const earlier of rates.slice(0, k - 1)) {
    if (earlier.rate === null) return null;
    prior.push(earlier.rate);
  }
  return { prior, rate: current };
}

type LotInput = Omit<BondEngineInput, "asOf">;

/** The lot itself: a positive integer quantity and a real purchase date. */
function validateLot(input: LotInput, asOf = ""): void {
  const { quantity, purchaseDate } = input.lot;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new BondEngineError(
      "QUANTITY_INVALID",
      { quantity: String(quantity) },
      `Quantity must be a positive integer: ${quantity}`,
    );
  }
  if (!isValidYMD(purchaseDate)) {
    throw new BondEngineError(
      "DATE_INVALID",
      { purchaseDate: String(purchaseDate), asOf },
      "purchaseDate must be a YYYY-MM-DD date",
    );
  }
}

/**
 * The boundary of every date: once a day passes this it is compared as text
 * (`compareYMD` does not validate).
 */
function validateDay(purchaseDate: string, asOf: string): void {
  if (!isValidYMD(asOf)) {
    throw new BondEngineError(
      "DATE_INVALID",
      { purchaseDate, asOf: String(asOf) },
      "purchaseDate and asOf must be YYYY-MM-DD dates",
    );
  }
  if (compareYMD(asOf, purchaseDate) < 0) {
    throw new BondEngineError(
      "AS_OF_BEFORE_PURCHASE",
      { asOf, purchaseDate },
      `asOf ${asOf} is before the purchase date ${purchaseDate}`,
    );
  }
}

/** Observations a value needs: every started period, completed or current. */
function neededMissing(
  rates: readonly PeriodRate[],
  startedCount: number,
): readonly MissingObservation[] {
  const seen = new Set<string>();
  const missing: MissingObservation[] = [];
  for (const entry of rates.slice(0, startedCount)) {
    const m = entry.missing;
    if (m && !seen.has(`${m.benchmarkId}|${m.observation}`)) {
      seen.add(`${m.benchmarkId}|${m.observation}`);
      missing.push(m);
    }
  }
  return missing;
}

function describeRule(
  rule: BondEngineInput["terms"]["rateRule"],
): RateRuleDescription {
  if (rule.type === "FIXED") {
    return {
      type: rule.type,
      benchmarkId: null,
      annualRate: rule.annualRate,
      firstPeriodRate: null,
      addend: null,
      benchmarkFloor: null,
    };
  }
  return {
    type: rule.type,
    benchmarkId: rule.benchmarkId,
    annualRate: null,
    firstPeriodRate: rule.firstPeriodRate,
    addend: rule.type === "BENCHMARK_PLUS_SPREAD" ? rule.spread : rule.margin,
    benchmarkFloor: rule.benchmarkFloor,
  };
}

function describeSchedule(
  terms: BondEngineInput["terms"],
  rates: readonly PeriodRate[],
): RateScheduleEntry[] {
  return rates.map((r) => ({
    index: r.period.index,
    start: r.period.start,
    end: r.period.end,
    annualRate: r.rate ? r.rate.toTrimmedString(10, 4) : null,
    rateSource: r.source,
    benchmark: r.benchmark,
    addend: r.addend,
    ...attributeInterest(terms, rates, r.period.index),
  }));
}

/** What a lot's rates give once `started` periods have begun; shared by every such day. */
interface Resolved extends RateResolution {
  readonly rateSchedule: readonly RateScheduleEntry[];
  readonly maturityPerBond: ExactDecimal | null;
  readonly maturityProjected: boolean;
  readonly missingFor: readonly MissingObservation[];
}

/**
 * A lot with its schedule and rate plan resolved once. A valuation on a day is
 * then a lookup of the rates for that day's count of started periods (at most
 * periodCount + 1 distinct sets) and the arithmetic of the day.
 */
interface PreparedLot {
  readonly input: LotInput;
  readonly compounding: boolean;
  readonly schedule: readonly SchedulePeriod[];
  readonly lastPeriod: SchedulePeriod;
  readonly maturity: string;
  readonly nominal: ExactDecimal;
  readonly places: number;
  readonly quantity: ExactDecimal;
  readonly plan: RatePlan;
  readonly saleRefusal: BondValuationRefusal | null;
  readonly byStarted: Map<number, Resolved>;
}

function saleWindowRefusal(input: LotInput): BondValuationRefusal | null {
  const window = input.terms.saleWindow;
  const { purchaseDate } = input.lot;
  if (
    window === null ||
    (compareYMD(purchaseDate, window.from) >= 0 &&
      compareYMD(purchaseDate, window.to) <= 0)
  ) {
    return null;
  }
  return {
    code: "PURCHASE_OUTSIDE_SALE_WINDOW",
    params: { from: window.from, to: window.to, purchaseDate },
  };
}

function prepare(input: LotInput): PreparedLot {
  const { terms } = input;
  const schedule = buildSchedule(
    input.lot.purchaseDate,
    terms.schedule.periodCount,
    terms.schedule.periodMonths,
  );
  const lastPeriod = schedule[schedule.length - 1];
  return {
    input,
    compounding: compounds(terms),
    schedule,
    lastPeriod,
    maturity: lastPeriod.end,
    nominal: nominalOf(terms),
    places: terms.rounding.moneyDecimals,
    quantity: ExactDecimal.fromInt(input.lot.quantity),
    plan: planPeriodRates(input, schedule),
    saleRefusal: saleWindowRefusal(input),
    byStarted: new Map(),
  };
}

function resolvedFor(p: PreparedLot, started: number): Resolved {
  const cached = p.byStarted.get(started);
  if (cached) return cached;
  const resolution = ratesWithStarted(p.plan, started);
  const { rates } = resolution;
  const terms = p.input.terms;
  const maturityInputs = inputsFor(p.compounding, rates, p.lastPeriod.index);
  const resolved: Resolved = {
    ...resolution,
    rateSchedule: describeSchedule(terms, rates),
    maturityPerBond: maturityInputs
      ? maturityValue(terms, maturityInputs.prior, maturityInputs.rate)
      : null,
    maturityProjected: p.compounding
      ? rates.some((r) => r.source === "PROJECTED")
      : rates[p.lastPeriod.index - 1].source === "PROJECTED",
    missingFor: neededMissing(rates, started),
  };
  p.byStarted.set(started, resolved);
  return resolved;
}

interface DayFigures {
  readonly status: BondLotStatus;
  readonly started: number;
  readonly matured: boolean;
  readonly current: SchedulePeriod | null;
  readonly principal: string | null;
  readonly accrued: string | null;
  readonly gross: string | null;
  readonly early: string | null;
  readonly refusal: EarlyRedemptionRefusal | null;
}

/** The value figures of one day (spec 2.4 to 2.6) from the rates of its started count. */
function figuresOn(p: PreparedLot, asOf: string): DayFigures {
  const { terms, calendars } = p.input;
  const started = startedPeriods(p.schedule, asOf);
  const { rates } = resolvedFor(p, started);
  const { compounding, nominal, places, lastPeriod } = p;
  const lot = (perBond: ExactDecimal) =>
    perBond.mul(p.quantity).toFixed(places);

  const matured = compareYMD(asOf, p.maturity) >= 0;
  const candidate = matured ? null : p.schedule[started - 1];
  const current =
    candidate && compareYMD(asOf, candidate.end) < 0 ? candidate : null;

  let principal: string | null = null;
  let accrued: string | null = null;
  let gross: string | null = null;
  let early: string | null = null;
  let refusal: EarlyRedemptionRefusal | null = windowRefusal(
    terms,
    calendars,
    p.input.lot.purchaseDate,
    asOf,
    current,
    p.maturity,
  );

  if (matured) {
    if (!compounding) {
      // A coupon bond redeems at its nominal whatever the rates were; its last
      // coupon is a past cash flow, so no rate is needed for the value.
      principal = nominal.toFixed(places);
      gross = lot(nominal);
      accrued = lot(nominal.sub(nominal));
    } else {
      const inputs = inputsFor(compounding, rates, lastPeriod.index);
      if (inputs) {
        const perBond = maturityValue(terms, inputs.prior, inputs.rate);
        principal = perBond.toFixed(places);
        gross = lot(perBond);
        accrued = lot(perBond.sub(nominal));
      }
    }
  } else if (current) {
    const inputs = inputsFor(compounding, rates, current.index);
    if (inputs) {
      const accruedDays = daysBetween(current.start, asOf);
      const value = valueAt(
        terms,
        inputs.prior,
        inputs.rate,
        accruedDays,
        current.days,
      );
      const grossBond = roundMoney(terms, value);
      principal = roundMoney(terms, baseAt(terms, inputs.prior)).toFixed(
        places,
      );
      gross = lot(grossBond);
      accrued = lot(grossBond.sub(nominal));
      if (refusal === null)
        early = lot(
          proceedsPerBond(
            terms,
            value,
            baseAt(terms, inputs.prior),
            current.index,
          ),
        );
    } else if (refusal === null) {
      refusal = "RATE_UNKNOWN";
    }
  }

  return {
    status: matured ? "MATURED" : "OPEN",
    started,
    matured,
    current,
    principal,
    accrued,
    gross,
    early,
    refusal,
  };
}

function refusedValuation(
  p: PreparedLot,
  asOf: string,
  refusal: BondValuationRefusal,
): BondValuation {
  const { terms, calendars } = p.input;
  return {
    asOf,
    seriesCode: terms.instrument.seriesCode,
    termsVersion: p.input.termsVersion,
    quantity: p.input.lot.quantity,
    maturityDate: p.maturity,
    status: "REFUSED",
    refusal,
    currentPeriod: null,
    rateRule: describeRule(terms.rateRule),
    rateSchedule: [],
    principal: null,
    accruedInterest: null,
    grossValue: null,
    earlyRedemptionValue: null,
    earlyRedemptionRefusal: null,
    knownCashflows: [],
    projectedCashflows: [],
    maturityValueKnown: null,
    maturityValueProjected: null,
    projectionAssumptions: [],
    projectionMissing: [],
    dataCompleteness: {
      termsComplete: [...referencedCalendarIds(terms)].every((id) =>
        calendars.has(id),
      ),
      referenceDataComplete: true,
      earlyRedemptionTermsComplete: true,
    },
    missing: [],
    valuationComplete: false,
  };
}

/** The whole valuation of an already validated day of a prepared lot. */
function valueOn(p: PreparedLot, asOf: string): BondValuation {
  if (p.saleRefusal) return refusedValuation(p, asOf, p.saleRefusal);
  const { terms, calendars } = p.input;
  const figures = figuresOn(p, asOf);
  const { matured, current, started } = figures;
  const resolved = resolvedFor(p, started);
  const { rates, maturityPerBond, maturityProjected } = resolved;
  const { compounding, nominal, lastPeriod } = p;
  const lot = (perBond: ExactDecimal) =>
    perBond.mul(p.quantity).toFixed(p.places);
  const currentRate = current ? rates[current.index - 1] : null;

  const cashflows: CashFlow[] = [];
  const flow = (
    period: SchedulePeriod,
    type: CashFlow["type"],
    perBond: ExactDecimal | null,
    projected: boolean,
  ): CashFlow => ({
    date: period.end,
    type,
    amount: perBond === null ? null : lot(perBond),
    status: perBond === null ? "UNKNOWN" : projected ? "PROJECTED" : "KNOWN",
    period: period.index,
  });
  if (!compounding) {
    for (const period of p.schedule) {
      if (compareYMD(period.end, asOf) <= 0) continue;
      const rate = rates[period.index - 1];
      const coupon = rate.rate === null ? null : couponOf(terms, rate.rate);
      cashflows.push(
        flow(period, "INTEREST", coupon, rate.source === "PROJECTED"),
      );
    }
    if (!matured) cashflows.push(flow(lastPeriod, "PRINCIPAL", nominal, false));
  } else if (!matured) {
    cashflows.push(
      flow(lastPeriod, "PRINCIPAL", maturityPerBond, maturityProjected),
    );
  }

  const missing = resolved.missingFor;
  const calendarsKnown = [...referencedCalendarIds(terms)].every((id) =>
    calendars.has(id),
  );
  const earlyTermsComplete =
    terms.redemption.type !== "ON_DEMAND" ||
    terms.redemption.blackouts.every((b) => calendars.has(b.calendarId));
  const dataCompleteness = {
    termsComplete: calendarsKnown,
    referenceDataComplete: missing.length === 0,
    earlyRedemptionTermsComplete: earlyTermsComplete,
  };

  return {
    asOf,
    seriesCode: terms.instrument.seriesCode,
    termsVersion: p.input.termsVersion,
    quantity: p.input.lot.quantity,
    maturityDate: p.maturity,
    status: figures.status,
    refusal: null,
    currentPeriod: current
      ? {
          index: current.index,
          start: current.start,
          end: current.end,
          annualRate: currentRate?.rate
            ? currentRate.rate.toTrimmedString(10, 4)
            : null,
          rateSource: currentRate?.rate ? currentRate.source : null,
        }
      : null,
    rateRule: describeRule(terms.rateRule),
    rateSchedule: resolved.rateSchedule,
    principal: figures.principal,
    accruedInterest: figures.accrued,
    grossValue: figures.gross,
    earlyRedemptionValue: figures.early,
    earlyRedemptionRefusal: figures.refusal,
    knownCashflows: cashflows.filter((c) => c.status === "KNOWN"),
    projectedCashflows: cashflows.filter((c) => c.status !== "KNOWN"),
    maturityValueKnown:
      maturityPerBond && !maturityProjected ? lot(maturityPerBond) : null,
    maturityValueProjected:
      maturityPerBond && maturityProjected ? lot(maturityPerBond) : null,
    projectionAssumptions: resolved.assumptions,
    projectionMissing: resolved.projectionMissing,
    dataCompleteness,
    missing,
    valuationComplete: Object.values(dataCompleteness).every(Boolean),
  };
}

/**
 * Value one holding lot (spec 2.4 to 2.6). All arithmetic is exact; rounding is
 * applied only where the terms round, per bond, and the lot is that amount times
 * the quantity. A lot bought outside the terms' sale window is REFUSED: no
 * figure, `valuationComplete` false.
 */
export function valueBondLot(input: BondEngineInput): BondValuation {
  validateLot(input, String(input.asOf));
  validateDay(input.lot.purchaseDate, input.asOf);
  return valueOn(prepare(input), input.asOf);
}

export type BondLotSeriesInput = Omit<BondEngineInput, "asOf"> & {
  /** `YYYY-MM-DD` days on or after the purchase date, in any order, repeats allowed. */
  readonly days: readonly string[];
};

function preparedSeries(input: BondLotSeriesInput): PreparedLot {
  const { days, ...lotInput } = input;
  validateLot(lotInput);
  for (const day of days) validateDay(lotInput.lot.purchaseDate, day);
  return prepare(lotInput);
}

/**
 * `valueBondLot` for many days of one lot, in the order of `days`, resolving the
 * schedule and the rates once. Exactly equal to calling `valueBondLot` for each
 * day with the same input (a period that has started has the same rate, or the
 * same missing observation, whichever day it is read from; one that has not
 * started does not enter the value). Throws on the first invalid day, as
 * `valueBondLot` would.
 */
export function valueBondLotSeries(
  input: BondLotSeriesInput,
): readonly BondValuation[] {
  const prepared = preparedSeries(input);
  return input.days.map((day) => valueOn(prepared, day));
}

/** One day of a gross value series. */
export interface GrossValuePoint {
  readonly asOf: string;
  readonly status: BondLotStatus;
  /** The lot's gross value, 2 decimals; null when it cannot be worked out or the lot is REFUSED. */
  readonly grossValue: string | null;
}

/**
 * The lightest series: per day only the lot's gross value (the figure a price
 * series needs) and the status, equal to `valueBondLot(...).grossValue` and
 * `.status` of that day. A null `grossValue` on an OPEN or MATURED lot means a
 * rate it needs is unknown.
 */
export function grossValueSeries(
  input: BondLotSeriesInput,
): readonly GrossValuePoint[] {
  const prepared = preparedSeries(input);
  return input.days.map((asOf): GrossValuePoint => {
    if (prepared.saleRefusal)
      return { asOf, status: "REFUSED", grossValue: null };
    const figures = figuresOn(prepared, asOf);
    return { asOf, status: figures.status, grossValue: figures.gross };
  });
}
