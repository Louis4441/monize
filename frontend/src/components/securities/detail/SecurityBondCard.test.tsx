import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityBondCard } from './SecurityBondCard';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';
import type {
  BondRateRule,
  BondRateScheduleEntry,
  BondValuation,
  SecurityBondValuation,
} from '@/types/bond';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      defaultCurrency: 'PLN',
    }),
  };
});
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2027-04-15',
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityBondValuation: vi.fn(),
    recomputeSecurityBondPrices: vi.fn(),
  },
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const security = {
  id: 'sec-1',
  symbol: 'TOS1029',
  name: 'TOS1029',
  currencyCode: 'PLN',
  bondInstrumentId: 'bond-1',
} as Security;

function lotValuation(overrides: Partial<BondValuation> = {}): BondValuation {
  return {
    asOf: '2027-04-15',
    seriesCode: 'TOS1029',
    termsVersion: 1,
    quantity: 10,
    maturityDate: '2029-10-01',
    currentPeriod: {
      index: 2,
      start: '2027-01-01',
      end: '2027-12-31',
      annualRate: '0.0440',
      rateSource: 'ANNOUNCED',
    },
    rateRule: {
      type: 'FIXED',
      benchmarkId: null,
      annualRate: '0.0440',
      firstPeriodRate: null,
      addend: null,
      benchmarkFloor: null,
    },
    rateSchedule: [],
    principal: '103.5000',
    accruedInterest: '55.2000',
    grossValue: '1090.2000',
    earlyRedemptionValue: '1085.2000',
    earlyRedemptionRefusal: null,
    knownCashflows: [
      { date: '2027-12-31', type: 'INTEREST', amount: '45.00', status: 'KNOWN', period: 2 },
    ],
    projectedCashflows: [],
    maturityValueKnown: '1200.0000',
    maturityValueProjected: null,
    projectionAssumptions: [],
    dataCompleteness: {
      termsComplete: true,
      referenceDataComplete: true,
      earlyRedemptionTermsComplete: true,
    },
    missing: [],
    valuationComplete: true,
    ...overrides,
  };
}

function response(
  overrides: Partial<SecurityBondValuation> = {},
): SecurityBondValuation {
  return {
    securityId: 'sec-1',
    instrument: {
      id: 'bond-1',
      issuerCountryCode: 'PL',
      issuerCode: 'PL_MF',
      programCode: 'RETAIL',
      seriesCode: 'TOS1029',
      currencyCode: 'PLN',
    },
    asOf: '2027-04-15',
    lots: [
      { purchaseDate: '2026-10-05', quantity: 10, purchaseDateAssumed: false, valuation: lotValuation() },
    ],
    totals: {
      quantity: 10,
      grossValue: '1090.2000',
      earlyRedemptionValue: '1085.2000',
      accruedInterest: '55.2000',
    },
    refusal: null,
    ...overrides,
  };
}

const get = vi.mocked(investmentsApi.getSecurityBondValuation);
const recompute = vi.mocked(investmentsApi.recomputeSecurityBondPrices);

async function mount(onPricesChanged?: () => void) {
  await act(async () => {
    render(<SecurityBondCard security={security} onPricesChanged={onPricesChanged} />);
  });
}

describe('SecurityBondCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue(response());
    recompute.mockResolvedValue({ written: 3, deleted: 0 });
  });

  it('asks for the valuation on the financial today and renders totals and lots', async () => {
    await mount();
    expect(get).toHaveBeenCalledWith('sec-1', '2027-04-15');
    expect(screen.getByText('Series TOS1029 (PL_MF, RETAIL, PL)')).toBeInTheDocument();
    const gross = screen.getByText('Gross value', { selector: 'dt' }).nextElementSibling!;
    expect(gross).toHaveTextContent('$1,090.20');
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getByText('4.4%')).toBeInTheDocument();
    expect(within(row).getByText('Announced')).toBeInTheDocument();
    expect(within(row).getByText('$1,085.20')).toBeInTheDocument();
    expect(within(row).getByText('Interest $45.00 on 12/31/2027')).toBeInTheDocument();
    expect(within(row).getByText(/Known\s+\$1,200\.00/)).toBeInTheDocument();
  });

  it('renders a null total as unknown with its reason, never as zero', async () => {
    get.mockResolvedValue(
      response({
        totals: { quantity: 10, grossValue: null, earlyRedemptionValue: null, accruedInterest: '55.2000' },
        lots: [
          {
            purchaseDate: '2026-10-05',
            quantity: 10,
            purchaseDateAssumed: true,
            valuation: lotValuation({ grossValue: null, principal: null, currentPeriod: null }),
          },
        ],
      }),
    );
    await mount();
    const gross = screen.getByText('Gross value', { selector: 'dt' }).nextElementSibling!;
    expect(gross).toHaveTextContent('Unknown');
    expect(gross).toHaveTextContent('At least one lot has no figure');
    expect(gross).not.toHaveTextContent('$0.00');
    expect(screen.getByText('Assumed')).toBeInTheDocument();
    expect(within(screen.getAllByRole('row')[1]).getAllByText('Unknown').length).toBeGreaterThan(0);
  });

  it('shows the early redemption refusal reason in place of a value', async () => {
    get.mockResolvedValue(
      response({
        lots: [
          {
            purchaseDate: '2027-04-10',
            quantity: 10,
            purchaseDateAssumed: false,
            valuation: lotValuation({
              earlyRedemptionValue: null,
              earlyRedemptionRefusal: 'TOO_EARLY',
            }),
          },
        ],
      }),
    );
    await mount();
    expect(screen.getByText('Too early to redeem')).toBeInTheDocument();
  });

  it('lists assumptions once and the missing data with its publisher', async () => {
    const v = lotValuation({
      projectionAssumptions: [
        { benchmarkId: 'WIBOR_6M', value: '0.0510', basis: 'SUPPLIED', observation: null },
        { benchmarkId: 'CPI_YOY', value: '0.0290', basis: 'LATEST_OBSERVATION', observation: '2026-08' },
      ],
      missing: [
        { benchmarkId: 'CPI_YOY', observation: '2027-02', publisher: 'GUS' },
        { benchmarkId: 'NBP_REF', observation: '2027-03-01', publisher: null },
      ],
      currentPeriod: { index: 3, start: '2027-01-01', end: '2027-12-31', annualRate: '0.0510', rateSource: 'PROJECTED' },
    });
    get.mockResolvedValue(
      response({
        lots: [
          { purchaseDate: '2026-10-05', quantity: 5, purchaseDateAssumed: false, valuation: v },
          { purchaseDate: '2026-11-05', quantity: 5, purchaseDateAssumed: false, valuation: v },
        ],
      }),
    );
    await mount();
    expect(screen.getAllByText('WIBOR_6M assumed at 5.1% for every later period')).toHaveLength(1);
    expect(
      screen.getAllByText(
        'CPI_YOY assumed at 2.9% for every later period, the latest published value (2026-08)',
      ),
    ).toHaveLength(1);
    expect(screen.getAllByText('CPI_YOY 2027-02 — published by GUS')).toHaveLength(1);
    expect(screen.getByText('NBP_REF 2027-03-01 — publisher not known')).toBeInTheDocument();
    expect(screen.getAllByText('Projected').length).toBeGreaterThan(0);
  });

  it('renders a lots refusal with its detail and unknown totals', async () => {
    get.mockResolvedValue(
      response({
        lots: [],
        totals: { quantity: null, grossValue: null, earlyRedemptionValue: null, accruedInterest: null },
        refusal: { code: 'OVER_REMOVAL', detail: 'Sell of 12 on 2027-01-05 exceeds 10 held' },
      }),
    );
    await mount();
    expect(screen.getByText(/more bonds were removed than were held/)).toBeInTheDocument();
    expect(screen.getByText('Sell of 12 on 2027-01-05 exceeds 10 held')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBe(4);
  });

  it('shows an error state, not an empty valuation, when the request fails', async () => {
    get.mockRejectedValue(new Error('boom'));
    await mount();
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText('Gross value', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('recomputes, refetches and tells the page to re-read prices', async () => {
    const onPricesChanged = vi.fn();
    await mount(onPricesChanged);
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recalculate prices' }));
    });
    expect(recompute).toHaveBeenCalledWith('sec-1');
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(onPricesChanged).toHaveBeenCalledTimes(1);
  });

  it('does not refetch or notify when the recompute fails', async () => {
    recompute.mockRejectedValue(new Error('nope'));
    const onPricesChanged = vi.fn();
    await mount(onPricesChanged);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recalculate prices' }));
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(onPricesChanged).not.toHaveBeenCalled();
  });

  describe('interest rate section', () => {
    const CPI = 'PL_CPI_GUS_YOY';
    const edoRule: BondRateRule = {
      type: 'INFLATION_PLUS_MARGIN_AS_RATE',
      benchmarkId: CPI,
      annualRate: null,
      firstPeriodRate: '0.0535',
      addend: '0.0200',
      benchmarkFloor: '0',
    };
    const entry = (
      over: Partial<BondRateScheduleEntry> & Pick<BondRateScheduleEntry, 'index'>,
    ): BondRateScheduleEntry => ({
      start: '2027-10-01',
      end: '2028-10-01',
      annualRate: null,
      rateSource: null,
      benchmark: null,
      addend: null,
      ...over,
    });
    const edoSchedule: BondRateScheduleEntry[] = [
      entry({ index: 1, start: '2026-10-01', end: '2027-10-01', annualRate: '0.0535', rateSource: 'TERMS' }),
      entry({
        index: 2,
        annualRate: '0.0540',
        rateSource: 'DERIVED',
        benchmark: { benchmarkId: CPI, observation: '2027-08', value: '0.0340', flooredValue: '0.0340' },
        addend: '0.0200',
      }),
      entry({
        index: 3,
        annualRate: '0.0200',
        rateSource: 'DERIVED',
        benchmark: { benchmarkId: CPI, observation: '2028-08', value: '-0.0050', flooredValue: '0.0000' },
        addend: '0.0200',
      }),
      entry({
        index: 4,
        annualRate: '0.0500',
        rateSource: 'PROJECTED',
        benchmark: { benchmarkId: CPI, observation: '2029-08', value: '0.0300', flooredValue: '0.0300' },
        addend: '0.0200',
      }),
      entry({
        index: 5,
        annualRate: null,
        benchmark: { benchmarkId: CPI, observation: '2030-08', value: null, flooredValue: null },
        addend: '0.0200',
      }),
    ];

    async function mountWith(valuation: Partial<BondValuation>) {
      get.mockResolvedValue(
        response({
          lots: [
            { purchaseDate: '2026-10-01', quantity: 10, purchaseDateAssumed: false, valuation: lotValuation(valuation) },
          ],
        }),
      );
      await mount();
      const heading = screen.getByRole('heading', { name: 'Interest rate' });
      return heading.parentElement as HTMLElement;
    }

    it('says an inflation bond is CPI plus a margin, with the floor', async () => {
      const section = await mountWith({ rateRule: edoRule, rateSchedule: edoSchedule });
      expect(
        within(section).getByText('Period 1: 5.35%. Then CPI, 12 months (GUS) + 2%'),
      ).toBeInTheDocument();
      expect(
        within(section).getByText('A negative CPI, 12 months (GUS) counts as 0'),
      ).toBeInTheDocument();
    });

    it('omits the period 1 sentence when there is no first-period rate and no floor', async () => {
      const section = await mountWith({
        rateRule: { ...edoRule, firstPeriodRate: null, benchmarkFloor: null },
      });
      expect(
        within(section).getByText('Every period: CPI, 12 months (GUS) + 2%'),
      ).toBeInTheDocument();
      expect(within(section).queryByText(/Period 1/)).not.toBeInTheDocument();
      expect(within(section).queryByText(/counts as 0/)).not.toBeInTheDocument();
    });

    it('shows a fixed rate for the whole term', async () => {
      const section = await mountWith({});
      expect(within(section).getByText('Fixed 4.4% for the whole term')).toBeInTheDocument();
    });

    it('falls back to the raw benchmark id when it has no translated name', async () => {
      const section = await mountWith({
        rateRule: { ...edoRule, benchmarkId: 'XX_UNKNOWN_INDEX' },
      });
      expect(
        within(section).getByText('Period 1: 5.35%. Then XX_UNKNOWN_INDEX + 2%'),
      ).toBeInTheDocument();
    });

    it('lists every period with its rate, source and how it was set', async () => {
      const section = await mountWith({
        rateRule: edoRule,
        rateSchedule: edoSchedule,
        currentPeriod: { index: 2, start: '2027-10-01', end: '2028-10-01', annualRate: '0.0540', rateSource: 'DERIVED' },
      });
      const rows = within(section).getAllByRole('row');
      expect(rows).toHaveLength(1 + edoSchedule.length);

      // TERMS: the stated rate, no benchmark.
      expect(within(rows[1]).getByText('5.35%')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Terms')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Stated rate')).toBeInTheDocument();

      // DERIVED: the observation, its value and the margin; the current period.
      expect(within(rows[2]).getByText('5.4%')).toBeInTheDocument();
      expect(
        within(rows[2]).getByText('CPI, 12 months (GUS) 2027-08: 3.4% + 2%'),
      ).toBeInTheDocument();
      expect(rows[2]).toHaveAttribute('aria-current', 'true');
      expect(within(rows[2]).getByText('Current')).toBeInTheDocument();
      expect(rows[1]).not.toHaveAttribute('aria-current');

      // Floored: both the observed and the floored values are said.
      expect(
        within(rows[3]).getByText('CPI, 12 months (GUS) 2028-08: -0.5% + 2%'),
      ).toBeInTheDocument();
      expect(within(rows[3]).getByText('(floored to 0%)')).toBeInTheDocument();
      expect(within(rows[3]).getByText('2%')).toBeInTheDocument();

      // PROJECTED: the assumed value and the projected badge.
      expect(
        within(rows[4]).getByText('CPI, 12 months (GUS) 2029-08: 3% + 2%'),
      ).toBeInTheDocument();
      expect(within(rows[4]).getAllByText('Projected')).toHaveLength(2);

      // Missing: no rate, no source, the observation that is awaited.
      expect(
        within(rows[5]).getByText('CPI, 12 months (GUS) 2030-08: not published yet'),
      ).toBeInTheDocument();
      expect(within(rows[5]).getAllByText('Unknown')).toHaveLength(2);
    });

    it('formats a step-series observation day as a date', async () => {
      const section = await mountWith({
        rateRule: { ...edoRule, type: 'BENCHMARK_PLUS_SPREAD', benchmarkId: 'PL_NBP_REFERENCE', firstPeriodRate: null, benchmarkFloor: null },
        rateSchedule: [
          entry({
            index: 1,
            annualRate: '0.0475',
            rateSource: 'DERIVED',
            benchmark: { benchmarkId: 'PL_NBP_REFERENCE', observation: '2026-10-19', value: '0.0425', flooredValue: '0.0425' },
            addend: '0.0050',
          }),
        ],
      });
      expect(
        within(section).getByText('NBP reference rate 10/19/2026: 4.25% + 0.5%'),
      ).toBeInTheDocument();
    });

    it('labels each lot when there are several', async () => {
      get.mockResolvedValue(
        response({
          lots: [
            { purchaseDate: '2026-10-01', quantity: 5, purchaseDateAssumed: false, valuation: lotValuation() },
            { purchaseDate: '2026-11-05', quantity: 5, purchaseDateAssumed: false, valuation: lotValuation() },
          ],
        }),
      );
      await mount();
      expect(screen.getByText('Lot purchased 10/01/2026')).toBeInTheDocument();
      expect(screen.getByText('Lot purchased 11/05/2026')).toBeInTheDocument();
    });
  });
});
