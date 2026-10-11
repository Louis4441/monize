import { describe, it, expect } from 'vitest';
import {
  BOND_PROGRAM_TENOR_MONTHS,
  expectedSeriesCode,
  groupLotsBySeries,
  programFacts,
  programSeries,
  type HeldSeries,
} from './bond-series';
import type {
  BondInstrumentSummary,
  BondLotValuation,
  BondValuation,
  OfferSeries,
  SecurityBondValuation,
} from '@/types/bond';

describe('expectedSeriesCode', () => {
  it('names the program, then the month and year of the MATURITY', () => {
    expect(expectedSeriesCode('EDO', '2026-10-12')).toBe('EDO1036');
    expect(expectedSeriesCode('EDO', '2026-11-30')).toBe('EDO1136');
    expect(expectedSeriesCode('TOS', '2026-10-01')).toBe('TOS1029');
    expect(expectedSeriesCode('COI', '2026-01-15')).toBe('COI0130');
  });

  it('rolls the year over for a short tenor', () => {
    expect(expectedSeriesCode('OTS', '2026-10-12')).toBe('OTS0127');
    expect(expectedSeriesCode('ROR', '2026-12-31')).toBe('ROR1227');
    expect(expectedSeriesCode('DOR', '2026-12-31')).toBe('DOR1228');
  });

  it('keeps a two-digit year across the century', () => {
    expect(expectedSeriesCode('EDO', '2095-06-01')).toBe('EDO0605');
  });

  it('knows the tenor of every Polish retail program', () => {
    expect(BOND_PROGRAM_TENOR_MONTHS).toEqual({
      OTS: 3,
      ROR: 12,
      DOR: 24,
      TOS: 36,
      COI: 48,
      EDO: 120,
      ROS: 72,
      ROD: 144,
    });
  });

  it('is null for an unknown program or something that is not a calendar date', () => {
    expect(expectedSeriesCode('XYZ', '2026-10-12')).toBeNull();
    expect(expectedSeriesCode('EDO', '')).toBeNull();
    expect(expectedSeriesCode('EDO', '2026-13-01')).toBeNull();
    expect(expectedSeriesCode('EDO', '12/10/2026')).toBeNull();
  });
});

const inst = (
  id: string,
  seriesCode: string,
  over: Partial<BondInstrumentSummary> = {},
): BondInstrumentSummary => ({
  id,
  issuerCountryCode: 'PL',
  issuerCode: 'PL_MF',
  programCode: 'EDO',
  seriesCode,
  currencyCode: 'PLN',
  termsProvider: 'curated',
  ...over,
});

describe('programSeries', () => {
  it('keeps one program in one currency (and country), ordered by code', () => {
    const list = [
      inst('3', 'EDO1136'),
      inst('1', 'EDO0936'),
      inst('x', 'TOS1029', { programCode: 'TOS' }),
      inst('y', 'EDO0936', { currencyCode: 'EUR' }),
      inst('z', 'EDO0936', { issuerCountryCode: 'XX' }),
    ];
    expect(programSeries(list, 'EDO', 'PLN', 'PL').map((i) => i.id)).toEqual(['1', '3']);
    expect(programSeries(list, 'EDO', 'PLN').map((i) => i.id)).toEqual(['1', 'z', '3']);
  });

  it('does not reorder the list it was given', () => {
    const list = [inst('b', 'EDO1136'), inst('a', 'EDO0936')];
    programSeries(list, 'EDO', 'PLN');
    expect(list.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

function valuation(over: Partial<BondValuation> = {}): BondValuation {
  return {
    asOf: '2027-04-15',
    status: 'OPEN',
    refusal: null,
    seriesCode: 'EDO1036',
    termsVersion: 1,
    quantity: 1,
    maturityDate: '2036-10-01',
    currentPeriod: null,
    rateRule: { type: 'FIXED', benchmarkId: null, annualRate: '0.0500', firstPeriodRate: null, addend: null, benchmarkFloor: null },
    rateSchedule: [],
    principal: '100.0000',
    accruedInterest: '1.2000',
    grossValue: '101.2000',
    earlyRedemptionValue: '99.0000',
    earlyRedemptionRefusal: null,
    knownCashflows: [],
    projectedCashflows: [],
    nextPayment: [],
    nextRateReset: null,
    nextCapitalization: null,
    maturityValueKnown: null,
    maturityValueProjected: null,
    projectionAssumptions: [],
    dataCompleteness: { termsComplete: true, referenceDataComplete: true, earlyRedemptionTermsComplete: true },
    missing: [],
    projectionMissing: [],
    valuationComplete: true,
    ...over,
  };
}
const lot = (
  instrumentId: string,
  purchaseDate: string,
  quantity: number,
  over: Partial<BondValuation> = {},
): BondLotValuation => ({
  instrumentId,
  purchaseDate,
  quantity,
  purchaseDateAssumed: false,
  valuation: valuation({ quantity, ...over }),
});
const response = (lots: BondLotValuation[]): SecurityBondValuation => ({
  securityId: 's',
  program: { id: 'p', programCode: 'EDO', issuerCountryCode: 'PL', issuerCode: 'PL_MF', currency: 'PLN' },
  autoFetch: false,
  asOf: '2027-04-15',
  lots,
  series: [
    { instrumentId: 'a', seriesCode: 'EDO1036', programCode: 'EDO', redemptionTerms: null },
  ],
  totals: { quantity: null, grossValue: null, earlyRedemptionValue: null, accruedInterest: null },
  refusal: null,
});

describe('groupLotsBySeries', () => {
  it('makes one entry per series, in the order the series first appears', () => {
    const grouped = groupLotsBySeries(
      response([
        lot('b', '2026-11-02', 5, { seriesCode: 'EDO1136', maturityDate: '2036-11-01' }),
        lot('a', '2026-10-05', 10),
        lot('b', '2026-11-20', 3, { seriesCode: 'EDO1136', maturityDate: '2036-11-01' }),
      ]),
    );
    expect(grouped.map((g) => g.instrumentId)).toEqual(['b', 'a']);
    const b = grouped[0];
    expect(b.seriesCode).toBe('EDO1136');
    expect(b.quantity).toBe(8);
    expect(b.purchaseDates).toEqual(['2026-11-02', '2026-11-20']);
    expect(b.lots).toHaveLength(2);
    expect(b.maturityDate).toBe('2036-11-01');
  });

  it('sums money without float drift and carries the reference data of the series', () => {
    const [g] = groupLotsBySeries(
      response([
        lot('a', '2026-10-05', 1, { grossValue: '0.1000', accruedInterest: '0.1000', earlyRedemptionValue: '0.1000' }),
        lot('a', '2026-10-06', 1, { grossValue: '0.2000', accruedInterest: '0.2000', earlyRedemptionValue: '0.2000' }),
      ]),
    );
    expect(g.grossValue).toBe('0.3');
    expect(g.accruedInterest).toBe('0.3');
    expect(g.earlyRedemptionValue).toBe('0.3');
    expect(g.series?.seriesCode).toBe('EDO1036');
  });

  it('keeps a figure unknown when any lot of the series has none (a subtotal is not a total)', () => {
    const [g] = groupLotsBySeries(
      response([
        lot('a', '2026-10-05', 1),
        lot('a', '2026-10-06', 1, { grossValue: null, valuationComplete: false }),
      ]),
    );
    expect(g.grossValue).toBeNull();
    expect(g.accruedInterest).not.toBeNull();
    expect(g.incomplete).toBe(true);
  });

  it('is not complete only on a flag that says so (absent is no information)', () => {
    const [g] = groupLotsBySeries(response([lot('a', '2026-10-05', 1, { valuationComplete: undefined as never })]));
    expect(g.incomplete).toBe(false);
  });

  it('takes the lot bought last as the latest, and the earliest next rate reset', () => {
    const [g] = groupLotsBySeries(
      response([
        lot('a', '2026-10-05', 1, { nextRateReset: '2027-10-05' }),
        lot('a', '2026-10-20', 1, { nextRateReset: '2027-10-20' }),
      ]),
    );
    expect(g.latestLot.purchaseDate).toBe('2026-10-20');
    expect(g.nextRateReset).toBe('2027-10-05');
  });

  it('has no series reference data for a series the payload does not describe', () => {
    const [g] = groupLotsBySeries(response([lot('zzz', '2026-10-05', 1)]));
    expect(g.series).toBeNull();
  });

  it('has nothing for no lots', () => {
    expect(groupLotsBySeries(response([]))).toEqual([]);
  });
});

describe('programFacts', () => {
  const offer = (over: Partial<OfferSeries> = {}): OfferSeries => ({
    instrumentId: 'o',
    issuerCountryCode: 'PL',
    issuerCode: 'PL_MF',
    programCode: 'EDO',
    seriesCode: 'EDO1036',
    currency: 'PLN',
    saleWindow: { from: '2026-10-01', to: '2026-10-31' },
    periodMonths: 12,
    periodCount: 10,
    rateRule: { type: 'INFLATION_PLUS_MARGIN_AS_RATE', benchmarkId: 'CPI', annualRate: null, firstPeriodRate: '0.0560', addend: '0.0200', benchmarkFloor: '0' },
    capitalization: 'COMPOUND_AT_PERIOD_END',
    redemption: {
      type: 'ON_DEMAND',
      earliestDaysAfterPurchase: 7,
      latestDaysBeforeMaturity: 20,
      blackouts: [],
      penalties: [{ type: 'FIXED_FEE_PER_UNIT', amount: '3.00' }],
      proceedsFloor: { type: 'FACE_VALUE', appliesTo: 'FIRST_PERIOD' },
    },
    termsSource: { provider: 'p', url: '', document: 'd' },
    projection: { maturityValue: null, totalReturn: null, annualizedReturn: null, projected: false, assumptions: [], projectionMissing: [] },
    ...over,
  });

  it('reads the newest series on sale of the program, ignoring other programs', () => {
    const facts = programFacts(
      [
        offer({ seriesCode: 'EDO0936', saleWindow: { from: '2026-09-01', to: '2026-09-30' } }),
        offer(),
        offer({ seriesCode: 'TOS1029', programCode: 'TOS', saleWindow: { from: '2027-01-01', to: '2027-01-31' } }),
      ],
      [],
      'EDO',
    );
    expect(facts).toMatchObject({
      seriesCode: 'EDO1036',
      lengthMonths: 120,
      capitalization: 'COMPOUND_AT_PERIOD_END',
      fee: '3.00',
      floor: 'FIRST_PERIOD',
      redeemableAtMaturityOnly: false,
    });
  });

  it('says maturity only for a series with no early redemption, and no fee or floor', () => {
    const facts = programFacts([offer({ redemption: null })], [], 'EDO');
    expect(facts).toMatchObject({ redeemableAtMaturityOnly: true, fee: null, floor: null });
  });

  it('keeps no fee for a series that only forfeits interest', () => {
    const facts = programFacts(
      [offer({ redemption: { ...offer().redemption!, penalties: [{ type: 'FORFEIT_ACCRUED_SINCE_LAST_PAYMENT' }], proceedsFloor: null } })],
      [],
      'EDO',
    );
    expect(facts).toMatchObject({ fee: null, floor: null, redeemableAtMaturityOnly: false });
  });

  describe('with nothing on sale', () => {
    const held = (code: string, purchase: string, maturity: string, series: HeldSeries['series']): HeldSeries => {
      const l = lot('i-' + code, purchase, 1, { seriesCode: code, maturityDate: maturity });
      return {
        instrumentId: 'i-' + code,
        seriesCode: code,
        series,
        lots: [l],
        quantity: 1,
        purchaseDates: [purchase],
        grossValue: null,
        accruedInterest: null,
        earlyRedemptionValue: null,
        latestLot: l,
        maturityDate: maturity,
        nextRateReset: null,
        incomplete: false,
      };
    };

    it('falls back to the series bought last: its rule, its length in months, its early redemption terms', () => {
      const facts = programFacts(
        [],
        [
          held('EDO0936', '2026-09-03', '2036-09-01', null),
          held('EDO1036', '2026-10-05', '2036-10-01', {
            instrumentId: 'i-EDO1036',
            seriesCode: 'EDO1036',
            programCode: 'EDO',
            redemptionTerms: {
              type: 'ON_DEMAND',
              earliestDaysAfterPurchase: 7,
              latestDaysBeforeMaturity: 20,
              blackouts: [],
              penalties: [{ type: 'FIXED_FEE_PER_UNIT', amount: '2.00' }],
              proceedsFloor: null,
            },
          }),
        ],
        'EDO',
      );
      expect(facts).toMatchObject({
        seriesCode: 'EDO1036',
        lengthMonths: 120,
        capitalization: null,
        fee: '2.00',
        floor: null,
        redeemableAtMaturityOnly: false,
      });
      expect(facts?.rateRule.type).toBe('FIXED');
    });

    it('does not call a series maturity-only when its reference data is missing', () => {
      const facts = programFacts([], [held('EDO0936', '2026-09-03', '2036-09-01', null)], 'EDO');
      expect(facts?.redeemableAtMaturityOnly).toBe(false);
    });

    it('is null with neither a series on sale nor one held', () => {
      expect(programFacts([offer({ programCode: 'TOS' })], [], 'EDO')).toBeNull();
    });
  });
});
