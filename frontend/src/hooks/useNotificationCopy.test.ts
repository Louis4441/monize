import { describe, it, expect } from 'vitest';
import { renderHook } from '@/test/render';
import { useNotificationCopy } from './useNotificationCopy';

type Row = { type: string; title: string; message: string; data: Record<string, unknown> };

const row = (type: string, data: Record<string, unknown>): Row => ({
  type,
  title: 'stored title',
  message: 'stored message',
  data,
});

function copyOf(notification: Row) {
  const { result } = renderHook(() => useNotificationCopy());
  return result.current(notification);
}

const base = { securityId: 's1', accountId: 'a1', instrumentId: 'i1', currency: 'PLN' };

describe('useNotificationCopy: bond notifications', () => {
  it('BOND_MATURITY_SOON states the payout when it is known', () => {
    const copy = copyOf(
      row('BOND_MATURITY_SOON', {
        ...base,
        seriesCode: 'EDO1026',
        maturityDate: '2026-10-25',
        quantity: 40,
        payout: '4500.00',
        interest: '500.00',
        principalReturned: '4000.00',
        missing: null,
      }),
    );
    expect(copy.title).toContain('EDO1026');
    expect(copy.message).toContain('40 x EDO1026');
    expect(copy.message).toMatch(/payout is .*4,500\.00/);
    expect(copy.message).not.toContain('not known');
  });

  it('BOND_MATURITY_SOON says the payout is not known yet, with the reason, never zero', () => {
    const copy = copyOf(
      row('BOND_MATURITY_SOON', {
        ...base,
        seriesCode: 'EDO1026',
        maturityDate: '2026-10-25',
        quantity: 40,
        payout: null,
        interest: null,
        principalReturned: null,
        missing: 'RATE_UNKNOWN',
      }),
    );
    expect(copy.message).toContain('The payout is not known yet: a rate it depends on is not published yet.');
    expect(copy.message).not.toMatch(/0\.00/);
  });

  it('BOND_REDEMPTION_UNBOOKED composes known and unknown payouts', () => {
    const data = {
      ...base,
      seriesCode: 'ROR0925',
      maturityDate: '2026-10-01',
      quantity: 10,
      interest: null,
      principalReturned: null,
    };
    const known = copyOf(row('BOND_REDEMPTION_UNBOOKED', { ...data, payout: '1020.00', missing: null }));
    expect(known.title).toContain('redemption not booked');
    expect(known.message).toMatch(/1,020\.00/);
    const unknown = copyOf(
      row('BOND_REDEMPTION_UNBOOKED', { ...data, payout: null, missing: 'SOMETHING_ELSE' }),
    );
    expect(unknown.message).toContain('it cannot be worked out from the data stored');
  });

  it('BOND_INTEREST_PAYMENT shows the amount, or that it is not known yet', () => {
    const data = { ...base, seriesCode: 'COI1029', paymentDate: '2026-10-13', quantity: 10 };
    const known = copyOf(row('BOND_INTEREST_PAYMENT', { ...data, amount: '51.00' }));
    expect(known.message).toMatch(/51\.00/);
    const unknown = copyOf(row('BOND_INTEREST_PAYMENT', { ...data, amount: null }));
    expect(unknown.message).toContain('The amount is not known yet');
    expect(unknown.message).not.toMatch(/\d\.00/);
  });

  it('BOND_RATE_RESET formats the fraction as a percentage', () => {
    const copy = copyOf(
      row('BOND_RATE_RESET', {
        ...base,
        seriesCode: 'EDO1026',
        periodStart: '2026-10-13',
        periodEnd: '2027-10-13',
        periodIndex: 2,
        annualRate: '0.069',
        rateSource: 'DERIVED',
      }),
    );
    expect(copy.message).toContain('6.90%');
    expect(copy.message).toContain('period 2');
  });

  it('BOND_BENCHMARK_PUBLISHED lists the series and the count left out', () => {
    const copy = copyOf(
      row('BOND_BENCHMARK_PUBLISHED', {
        securityId: null,
        accountId: null,
        instrumentId: null,
        seriesCode: null,
        currency: 'PLN',
        benchmarkId: 'PL_CPI_GUS_YOY',
        publisher: 'GUS',
        observation: '2026-09',
        value: '0.0490000000',
        unit: 'RATE_FRACTION',
        publishedOn: '2026-10-13',
        affected: [
          { instrumentId: 'i1', seriesCode: 'EDO1026', periodStart: '2026-11-01', annualRate: '0.069', rateSource: 'DERIVED' },
          { instrumentId: 'i2', seriesCode: 'COI1029', periodStart: '2026-12-01', annualRate: null, rateSource: null },
        ],
        affectedMore: 3,
      }),
    );
    expect(copy.title).toContain('CPI, 12 months (GUS)');
    expect(copy.title).not.toContain('PL_CPI_GUS_YOY');
    expect(copy.title).toContain('September 2026');
    expect(copy.message).toContain('GUS published CPI, 12 months (GUS) for September 2026: 4.90%.');
    expect(copy.message).toContain('EDO1026');
    expect(copy.message).toContain('6.90%');
    expect(copy.message).toContain('COI1029');
    expect(copy.message).toContain('the rate is not known yet');
    expect(copy.message).toContain('And 3 more.');
  });

  it('BOND_BENCHMARK_PUBLISHED shows an unknown unit as a plain number and an unlabelled benchmark by its id', () => {
    const copy = copyOf(
      row('BOND_BENCHMARK_PUBLISHED', {
        currency: 'PLN',
        benchmarkId: 'XX_OTHER',
        publisher: 'Pub',
        observation: '2026-09',
        value: '123.5',
        unit: 'INDEX_POINTS',
        affected: [{ seriesCode: 'S1', periodStart: '2026-11-01', annualRate: null }],
        affectedMore: 0,
      }),
    );
    expect(copy.title).toContain('XX_OTHER');
    expect(copy.message).toContain('123.5');
    expect(copy.message).not.toContain('%');
  });

  it('BOND_DATA_MISSING gives one sentence per cause with what to do', () => {
    const copy = copyOf(
      row('BOND_DATA_MISSING', {
        ...base,
        seriesCode: null,
        causes: [
          { code: 'OBSERVATION_MISSING', benchmarkId: 'PL_CPI_GUS_YOY', observation: '2026-08', publisher: 'GUS' },
          { code: 'PURCHASE_OUTSIDE_SALE_WINDOW', instrumentId: 'i1', seriesCode: 'EDO1026', purchaseDate: '2026-01-05', from: '2026-02-01', to: '2026-02-28' },
          { code: 'LOTS_UNDERIVABLE', refusalCode: 'NEGATIVE_QUANTITY' },
        ],
      }),
    );
    expect(copy.title).toBe('Bond figures are not known yet');
    expect(copy.message).toContain('The August 2026 observation of CPI, 12 months (GUS) (GUS) is not stored');
    expect(copy.message).toContain('Refresh on the bond page.');
    expect(copy.message).toContain('Correct the purchase date.');
    expect(copy.message).toContain('(NEGATIVE_QUANTITY). Correct the ledger.');
  });

  it('falls back to the stored English when the facts are missing', () => {
    const copy = copyOf(row('BOND_INTEREST_PAYMENT', { seriesCode: 'COI1029' }));
    expect(copy.title).toBe('stored title');
    expect(copy.message).toBe('stored message');
  });
});
