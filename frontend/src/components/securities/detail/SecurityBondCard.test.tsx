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
      // Like the real hook: the code when given, the default currency otherwise.
      formatCurrencyAxis: (value: number, code?: unknown) =>
        `${typeof code === 'string' ? code : 'DEFAULT'} ${value}`,
    }),
  };
});
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2027-04-15',
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityBondValuation: vi.fn(),
    getSecurityBondScenarios: vi.fn(),
    recomputeSecurityBondPrices: vi.fn(),
  },
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children, data }: any) => (
    <div data-testid="bar-chart" data-points={data.length}>
      {children}
    </div>
  ),
  Bar: ({ name, fill, children }: any) => (
    <div data-testid="bar" data-name={name} data-fill={fill}>
      {children}
    </div>
  ),
  Cell: ({ fillOpacity }: any) => <i data-testid="cell" data-opacity={fillOpacity} />,
  XAxis: () => null,
  YAxis: ({ tickFormatter }: any) =>
    tickFormatter ? <span data-testid="y-tick">{tickFormatter(100, 0)}</span> : null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
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
    status: 'OPEN',
    refusal: null,
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
    projectionMissing: [],
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
const scenarios = vi.mocked(investmentsApi.getSecurityBondScenarios);

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
    scenarios.mockResolvedValue({
      securityId: 'sec-1',
      benchmarkId: 'PL_CPI_GUS_YOY',
      asOf: '2027-04-15',
      refusal: null,
      scenarios: [],
    });
  });

  it('asks for the valuation on the financial today and renders totals and lots', async () => {
    await mount();
    expect(get).toHaveBeenCalledWith('sec-1', '2027-04-15', undefined);
    expect(screen.getByText('Series TOS1029 (Ministry of Finance (PL), RETAIL, PL)')).toBeInTheDocument();
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
            // The period is known, so only the two money cells can read Unknown.
            valuation: lotValuation({
              grossValue: null,
              principal: null,
              earlyRedemptionValue: null,
              earlyRedemptionRefusal: 'RATE_UNKNOWN',
            }),
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
    const row = screen.getAllByRole('row')[1];
    const cells = within(row).getAllByRole('cell');
    // Columns: purchase, quantity, maturity, period, rate, principal, accrued, gross, early, next, maturity value.
    expect(cells[5]).toHaveTextContent('Unknown');
    expect(cells[7]).toHaveTextContent('Unknown');
    expect(cells[3]).not.toHaveTextContent('Unknown');
    expect(row).not.toHaveTextContent('$0.00');
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
    // An id without a translated name is shown as is; a monthly key stays YYYY-MM.
    expect(screen.getAllByText('WIBOR_6M assumed at 5.1% for every later period')).toHaveLength(1);
    expect(
      screen.getAllByText(
        'CPI_YOY assumed at 2.9% for every later period, the latest published value (2026-08)',
      ),
    ).toHaveLength(1);
    expect(screen.getAllByText('CPI_YOY 2027-02 — published by GUS')).toHaveLength(1);
    // A step-series day is formatted by the reader's date preference.
    expect(screen.getByText('NBP_REF 03/01/2027 — publisher not known')).toBeInTheDocument();
    expect(screen.getAllByText('Projected').length).toBeGreaterThan(0);
  });

  it('shows translated benchmark names and localized dates in the assumptions and missing lists', async () => {
    get.mockResolvedValue(
      response({
        lots: [
          {
            purchaseDate: '2026-10-05',
            quantity: 5,
            purchaseDateAssumed: false,
            valuation: lotValuation({
              projectionAssumptions: [
                { benchmarkId: 'PL_NBP_REFERENCE', value: '0.0425', basis: 'LATEST_OBSERVATION', observation: '2026-10-19' },
              ],
              missing: [
                { benchmarkId: 'PL_NBP_REFERENCE', observation: '2026-10-19', publisher: 'NBP' },
                { benchmarkId: 'PL_CPI_GUS_YOY', observation: '2027-02', publisher: 'GUS' },
              ],
            }),
          },
        ],
      }),
    );
    await mount();
    expect(
      screen.getByText(
        'NBP reference rate assumed at 4.25% for every later period, the latest published value (10/19/2026)',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('NBP reference rate 10/19/2026 — published by NBP')).toBeInTheDocument();
    expect(screen.getByText('CPI, 12 months (GUS) 2027-02 — published by GUS')).toBeInTheDocument();
    expect(screen.queryByText(/PL_NBP_REFERENCE|PL_CPI_GUS_YOY/)).not.toBeInTheDocument();
  });

  it('renders a lots refusal with its detail and unknown totals', async () => {
    get.mockResolvedValue(
      response({
        lots: [],
        totals: { quantity: null, grossValue: null, earlyRedemptionValue: null, accruedInterest: null },
        refusal: {
          code: 'OVER_REMOVAL',
          detail: 'English server text that must not be shown',
          params: { action: 'SELL', date: '2027-01-05', quantity: '12' },
        },
      }),
    );
    await mount();
    expect(screen.getByText(/more bonds were removed than were held/)).toBeInTheDocument();
    // Composed on the client from code and params: translated action, the reader's date.
    expect(screen.getByText('Sell on 01/05/2027 removes 12 bonds, more than were held.')).toBeInTheDocument();
    expect(screen.queryByText(/English server text/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBe(4);
  });

  it.each([
    [
      'SPLIT',
      { action: 'SPLIT', date: '2027-03-04', quantity: '2' },
      'A split (Split on 03/04/2027) is recorded on this security; a bond does not split.',
    ],
    [
      'FRACTIONAL_QUANTITY',
      { action: 'SELL', date: '2027-03-04', quantity: '1.5' },
      'Sell on 03/04/2027 moves 1.5 bonds, which is not a whole number.',
    ],
    [
      'INVALID_QUANTITY',
      { action: 'BUY', date: '2027-03-04', quantity: null },
      'The quantity of Buy on 03/04/2027 is missing, negative or too large.',
    ],
  ] as const)('renders the %s refusal only from its code and params', async (code, params, text) => {
    get.mockResolvedValue(
      response({
        lots: [],
        totals: { quantity: null, grossValue: null, earlyRedemptionValue: null, accruedInterest: null },
        refusal: { code, detail: 'raw server English', params },
      }),
    );
    await mount();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('raw server English')).not.toBeInTheDocument();
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

  describe('as-of date', () => {
    const changeDate = (value: string) => {
      const input = screen.getByLabelText('Valued on');
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    };

    it('refetches for the picked day and hides the previous day while it loads', async () => {
      await mount();
      expect(screen.getByText('Gross value', { selector: 'dt' }).nextElementSibling).toHaveTextContent('$1,090.20');
      let resolveSecond!: (value: SecurityBondValuation) => void;
      get.mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
      await act(async () => {
        changeDate('03/30/2027');
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-03-30', undefined);
      // Day A's figures are not shown under day B's label while B is pending.
      expect(screen.getByText('Loading the bond valuation...')).toBeInTheDocument();
      expect(screen.queryByText('$1,090.20')).not.toBeInTheDocument();
      expect(screen.queryByText('Gross value', { selector: 'dt' })).not.toBeInTheDocument();

      await act(async () => {
        resolveSecond(
          response({
            asOf: '2027-03-30',
            totals: { quantity: 10, grossValue: '1111.1100', earlyRedemptionValue: null, accruedInterest: '1.00' },
          }),
        );
      });
      expect(screen.getByText('Gross value', { selector: 'dt' }).nextElementSibling).toHaveTextContent('$1,111.11');
    });

    it('falls back to the financial today when the date is cleared', async () => {
      await mount();
      await act(async () => {
        changeDate('03/30/2027');
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-03-30', undefined);
      await act(async () => {
        changeDate('');
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', undefined);
    });
  });

  describe('lots table branches', () => {
    const flow = (
      over: Partial<BondValuation['knownCashflows'][number]> &
        Pick<BondValuation['knownCashflows'][number], 'date' | 'type' | 'amount'>,
    ) => ({ status: 'KNOWN' as const, period: 1, ...over });
    const mountLot = async (valuation: Partial<BondValuation>) => {
      get.mockResolvedValue(
        response({
          lots: [
            { purchaseDate: '2026-10-05', quantity: 10, purchaseDateAssumed: false, valuation: lotValuation(valuation) },
          ],
        }),
      );
      await mount();
      return within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    };

    it('shows the earliest flow, a projected one before the known one, with the Projected badge', async () => {
      const cells = await mountLot({
        knownCashflows: [
          flow({ date: '2027-12-31', type: 'INTEREST', amount: '45.00' }),
          flow({ date: '2028-12-31', type: 'INTEREST', amount: '46.00' }),
        ],
        projectedCashflows: [flow({ date: '2027-09-30', type: 'INTEREST', amount: '12.00', status: 'PROJECTED' })],
      });
      const next = cells[9];
      expect(next).toHaveTextContent('Interest $12.00 on 09/30/2027');
      expect(within(next).getByText('Projected')).toBeInTheDocument();
      expect(next).not.toHaveTextContent('12/31/2027');
      expect(next).not.toHaveTextContent('2028');
    });

    it('shows the earlier known flow when a projected one comes later', async () => {
      const cells = await mountLot({
        knownCashflows: [flow({ date: '2027-03-30', type: 'INTEREST', amount: '45.00' })],
        projectedCashflows: [flow({ date: '2027-12-31', type: 'INTEREST', amount: '12.00', status: 'PROJECTED' })],
      });
      expect(cells[9]).toHaveTextContent('Interest $45.00 on 03/30/2027');
      expect(within(cells[9]).queryByText('Projected')).not.toBeInTheDocument();
    });

    it('shows the coupon and the principal paid on the same day, each labelled', async () => {
      const cells = await mountLot({
        knownCashflows: [
          flow({ date: '2027-07-05', type: 'PRINCIPAL', amount: '1000.00' }),
          flow({ date: '2027-07-05', type: 'INTEREST', amount: '5.00' }),
        ],
      });
      const lines = Array.from(cells[9].children).map((c) => c.textContent);
      expect(lines).toEqual(['Interest $5.00 on 07/05/2027', 'Principal $1,000.00 on 07/05/2027']);
    });

    it('keeps a projected coupon visible beside a known principal on the same day', async () => {
      const cells = await mountLot({
        knownCashflows: [flow({ date: '2027-07-05', type: 'PRINCIPAL', amount: '1000.00' })],
        projectedCashflows: [flow({ date: '2027-07-05', type: 'INTEREST', amount: '5.00', status: 'PROJECTED' })],
      });
      expect(cells[9]).toHaveTextContent('Interest $5.00 on 07/05/2027');
      expect(cells[9]).toHaveTextContent('Principal $1,000.00 on 07/05/2027');
      expect(within(cells[9]).getAllByText('Projected')).toHaveLength(1);
    });

    it('shows the projected maturity value on its own line', async () => {
      const cells = await mountLot({ maturityValueKnown: null, maturityValueProjected: '1350.0000' });
      expect(cells[10]).toHaveTextContent(/Known\s+Unknown/);
      expect(cells[10]).toHaveTextContent(/Projected\s+\$1,350\.00/);
    });

    it('reads Unknown when an early redemption has neither a value nor a refusal', async () => {
      const cells = await mountLot({ earlyRedemptionValue: null, earlyRedemptionRefusal: null });
      expect(cells[8]).toHaveTextContent('Unknown');
      expect(cells[8]).not.toHaveTextContent('$0.00');
    });

    it('shows None and Matured for a matured lot with no flows left', async () => {
      const cells = await mountLot({
        knownCashflows: [],
        projectedCashflows: [],
        earlyRedemptionValue: null,
        earlyRedemptionRefusal: 'MATURED',
      });
      expect(cells[9]).toHaveTextContent('None');
      expect(cells[8]).toHaveTextContent('Matured');
    });

    it('says no lots are open, with known zero totals, when there are none and no refusal', async () => {
      get.mockResolvedValue(
        response({
          lots: [],
          totals: { quantity: 0, grossValue: '0.0000', earlyRedemptionValue: '0.0000', accruedInterest: '0.0000' },
        }),
      );
      await mount();
      expect(screen.getByText('No lots are open on this date.')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByText('Gross value', { selector: 'dt' }).nextElementSibling).toHaveTextContent('$0.00');
      expect(screen.getByText('Gross value', { selector: 'dt' }).nextElementSibling).not.toHaveTextContent('Unknown');
    });
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
      interest: null,
      fixedPart: null,
      benchmarkPart: null,
      addendPart: null,
      announcedPart: null,
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

describe('SecurityBondCard: indexation, scenarios and the interest chart (spec 13.1 to 13.4)', () => {
  const CPI = 'PL_CPI_GUS_YOY';
  const rule = (over: Partial<BondRateRule> = {}): BondRateRule => ({
    type: 'INFLATION_PLUS_MARGIN_AS_RATE',
    benchmarkId: CPI,
    annualRate: null,
    firstPeriodRate: '0.0535',
    addend: '0.0200',
    benchmarkFloor: '0',
    ...over,
  });
  const period = (
    index: number,
    over: Partial<BondRateScheduleEntry> = {},
  ): BondRateScheduleEntry => ({
    index,
    start: `${2025 + index}-10-01`,
    end: `${2026 + index}-10-01`,
    annualRate: '0.0540',
    rateSource: 'DERIVED',
    benchmark: null,
    addend: '0.0200',
    interest: '0',
    fixedPart: '0',
    benchmarkPart: '0',
    addendPart: '0',
    announcedPart: '0',
    ...over,
  });
  // Per bond, computed independently with python fractions (EDO1036).
  const schedule: BondRateScheduleEntry[] = [
    period(1, {
      rateSource: 'TERMS',
      addend: null,
      interest: '5.35',
      fixedPart: '5.35',
    }),
    period(2, { interest: '5.6889', benchmarkPart: '3.5819', addendPart: '2.107' }),
    period(3, {
      rateSource: 'PROJECTED',
      interest: '7.772723',
      benchmarkPart: '5.551945',
      addendPart: '2.220778',
    }),
    period(4, {
      annualRate: null,
      rateSource: null,
      interest: null,
      fixedPart: null,
      benchmarkPart: null,
      addendPart: null,
      announcedPart: null,
    }),
  ];
  const assumption = {
    benchmarkId: CPI,
    value: '0.0500',
    basis: 'SUPPLIED' as const,
    observation: null,
  };
  const scenarioRows = [
    { value: '0', maturityValue: '1301.00', totalInterest: '301.00', fixedInterest: '53.50', benchmarkInterest: '35.82', addendInterest: '211.68', announcedInterest: '0.00' },
    { value: '0.025', maturityValue: '1500.00', totalInterest: null, fixedInterest: '53.50', benchmarkInterest: null, addendInterest: null, announcedInterest: null },
    { value: '0.05', maturityValue: '1907.90', totalInterest: '907.86', fixedInterest: '53.50', benchmarkInterest: '605.44', addendInterest: '248.92', announcedInterest: '0.00' },
    { value: '0.08', maturityValue: '2400.00', totalInterest: '1400.00', fixedInterest: '53.50', benchmarkInterest: '900.00', addendInterest: '300.00', announcedInterest: '0.00' },
  ];

  function withLots(valuation: Partial<BondValuation>, purchaseDates = ['2026-10-01']) {
    get.mockResolvedValue(
      response({
        lots: purchaseDates.map((purchaseDate) => ({
          purchaseDate,
          quantity: 10,
          purchaseDateAssumed: false,
          valuation: lotValuation({
            rateRule: rule(),
            rateSchedule: schedule,
            projectionAssumptions: [assumption],
            ...valuation,
          }),
        })),
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue(response());
    recompute.mockResolvedValue({ written: 0, deleted: 0 });
    scenarios.mockResolvedValue({
      securityId: 'sec-1',
      benchmarkId: CPI,
      asOf: '2027-04-15',
      refusal: null,
      scenarios: scenarioRows,
    });
  });

  describe('indexation notice (13.1)', () => {
    it("says an inflation bond is indexed, from the lot's own period 2 start", async () => {
      withLots({}, ['2026-10-01', '2026-11-05']);
      await mount();
      const notes = screen.getAllByRole('note');
      expect(notes).toHaveLength(2);
      expect(notes[0]).toHaveTextContent(
        'Inflation-indexed: from 10/01/2027 (period 2) the rate is CPI, 12 months (GUS) + 2%, recalculated every period',
      );
    });

    it('uses the floating-rate wording for a reference-rate rule', async () => {
      withLots({
        rateRule: rule({ type: 'BENCHMARK_PLUS_SPREAD', benchmarkId: 'PL_NBP_REFERENCE', addend: '0.0050' }),
      });
      await mount();
      expect(screen.getByRole('note')).toHaveTextContent(
        'Floating rate: from 10/01/2027 (period 2) the rate is NBP reference rate + 0.5%, recalculated every period',
      );
    });

    it('says nothing for a fixed rate', async () => {
      await mount();
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      expect(screen.queryByText('Inflation scenarios')).not.toBeInTheDocument();
      expect(scenarios).not.toHaveBeenCalled();
    });
  });

  describe('scenario panel (13.3)', () => {
    it('asks once for the four presets, and shows every figure, unknown ones as Unknown', async () => {
      withLots({});
      await mount();
      expect(scenarios).toHaveBeenCalledTimes(1);
      expect(scenarios).toHaveBeenCalledWith('sec-1', CPI, ['0', '0.025', '0.05', '0.08'], '2027-04-15');
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByText('Projection')).toBeInTheDocument();
      const rows = within(panel).getAllByRole('row');
      expect(rows).toHaveLength(5);
      expect(within(rows[1]).getByText('0%')).toBeInTheDocument();
      expect(within(rows[1]).getByText('$1,301.00')).toBeInTheDocument();
      expect(within(rows[3]).getByText('$907.86')).toBeInTheDocument();
      // A null is Unknown, never $0.00.
      expect(within(rows[2]).getAllByText('Unknown')).toHaveLength(3);
      expect(within(panel).getByText('Maturity value (projection)')).toBeInTheDocument();
      expect(within(panel).getByText('Interest from margin')).toBeInTheDocument();
      expect(within(panel).getByText('Interest from inflation')).toBeInTheDocument();
      expect(within(panel).getByText('Fixed interest (1st period)')).toBeInTheDocument();
    });

    it('adds the typed value to the one request, as a fraction', async () => {
      withLots({});
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      fireEvent.change(within(panel).getByLabelText('Your own CPI, 12 months (GUS) (%)'), {
        target: { value: '3.25' },
      });
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Add scenario' }));
      });
      expect(scenarios).toHaveBeenLastCalledWith('sec-1', CPI, ['0', '0.025', '0.05', '0.08', '0.0325'], '2027-04-15');
    });

    it('does not repeat a typed value that is a preset', async () => {
      withLots({});
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      fireEvent.change(within(panel).getByLabelText('Your own CPI, 12 months (GUS) (%)'), {
        target: { value: '2.5' },
      });
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Add scenario' }));
      });
      expect(scenarios).toHaveBeenCalledTimes(1);
    });

    it('clicking a row makes the valuation follow it, and the default can be restored', async () => {
      withLots({});
      await mount();
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', undefined);
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      await act(async () => {
        fireEvent.click(within(panel).getAllByRole('row')[3]);
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', {
        benchmarkId: CPI,
        value: '0.05',
      });
      // The panel stayed mounted through the reload, and marks the choice.
      const after = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(after).getAllByRole('row')[3]).toHaveAttribute('aria-current', 'true');
      expect(scenarios).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(within(after).getByRole('button', { name: 'Use the default assumption' }));
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', undefined);
      expect(within(after).queryByRole('button', { name: 'Use the default assumption' })).not.toBeInTheDocument();
    });

    it('is an error state with a retry when the scenarios cannot be loaded', async () => {
      withLots({});
      scenarios.mockRejectedValue(new Error('boom'));
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByRole('alert')).toHaveTextContent(/scenarios could not be loaded|boom/);
      expect(within(panel).queryAllByRole('row')).toHaveLength(0);
    });

    it('names the refusal and shows no invented figures when the lots cannot be derived', async () => {
      withLots({});
      scenarios.mockResolvedValue({
        securityId: 'sec-1',
        benchmarkId: CPI,
        asOf: '2027-04-15',
        refusal: { code: 'SPLIT', detail: 'split', params: { action: 'SPLIT', date: '2027-01-05', quantity: '2' } },
        scenarios: scenarioRows.slice(0, 1).map((r) => ({
          ...r,
          maturityValue: null,
          totalInterest: null,
          fixedInterest: null,
          benchmarkInterest: null,
          addendInterest: null,
          announcedInterest: null,
        })),
      });
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByText(/a bond does not split/)).toBeInTheDocument();
      expect(within(panel).getAllByText('Unknown')).toHaveLength(5);
    });
  });

  describe('interest chart (13.4)', () => {
    it('stacks the cumulative parts per period end, lighter when projected, and stops at an unknown period', async () => {
      withLots({});
      await mount();
      expect(screen.getByTestId('bar-chart')).toHaveAttribute('data-points', '3');
      const bars = screen.getAllByTestId('bar');
      expect(bars.map((b) => b.getAttribute('data-name'))).toEqual([
        'Fixed interest (1st period)',
        'Interest from margin',
        'Interest from inflation',
      ]);
      for (const bar of bars) {
        expect(bar.getAttribute('data-fill')).toMatch(/^var\(--chart-/);
        const opacities = within(bar).getAllByTestId('cell').map((c) => c.getAttribute('data-opacity'));
        expect(opacities).toEqual(['1', '1', '0.45']);
      }
      expect(screen.getByText('Projection assuming CPI, 12 months (GUS) = 5%', { exact: false })).toBeInTheDocument();
      expect(screen.getByText('Interest is not known from period 4, so the chart stops before it.')).toBeInTheDocument();
    });

    it('draws nothing for a fixed-rate bond without a schedule', async () => {
      await mount();
      expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
    });
  });
  describe('audit fixes', () => {
    const cashFlow = (over: Partial<BondValuation['knownCashflows'][number]>) => ({
      date: '2027-07-05',
      type: 'INTEREST' as const,
      amount: '5.00',
      status: 'KNOWN' as const,
      period: 1,
      ...over,
    });

    it('shows an UNKNOWN cash flow as the next one, with an unknown amount and no number', async () => {
      withLots({
        rateSchedule: [],
        rateRule: rule({ type: 'FIXED', benchmarkId: null }),
        knownCashflows: [cashFlow({ date: '2027-10-15', type: 'PRINCIPAL', amount: '1000.00' })],
        projectedCashflows: [
          cashFlow({ date: '2027-01-15', amount: null, status: 'UNKNOWN', period: 3 }),
          cashFlow({ date: '2027-02-15', amount: '3.80', status: 'PROJECTED', period: 4 }),
        ],
      });
      await mount();
      const next = within(screen.getAllByRole('row')[1]).getAllByRole('cell')[9];
      expect(next).toHaveTextContent('Interest Unknown on 01/15/2027');
      expect(within(next).getByText('Amount unknown')).toBeInTheDocument();
      expect(next).not.toHaveTextContent('$0.00');
      expect(next).not.toHaveTextContent('3.80');
    });

    it('lists a benchmark nothing can be projected from, with its publisher', async () => {
      withLots({
        projectionAssumptions: [],
        projectionMissing: [
          { benchmarkId: CPI, publisher: 'GUS' },
          { benchmarkId: 'PL_NBP_REFERENCE', publisher: null },
        ],
      });
      await mount();
      expect(screen.getByText('Later periods cannot be projected')).toBeInTheDocument();
      expect(
        screen.getByText(/CPI, 12 months \(GUS\): no value is published.*\(published by GUS\)/),
      ).toBeInTheDocument();
      expect(screen.getByText(/NBP reference rate: no value is published.*publisher not known/)).toBeInTheDocument();
    });

    it('draws the chart axis in the bond currency, not the default one', async () => {
      withLots({});
      await mount();
      const ticks = screen.getAllByTestId('y-tick');
      expect(ticks[0]).toHaveTextContent('PLN 100');
      expect(ticks[0]).not.toHaveTextContent('DEFAULT');
    });

    it('labels a fixed-rate bond fixed-rate interest for the whole term, without margin or benchmark bars', async () => {
      withLots({
        rateRule: rule({ type: 'FIXED', benchmarkId: null, annualRate: '0.0440', firstPeriodRate: null, addend: null }),
        rateSchedule: [
          period(1, { rateSource: 'TERMS', addend: null, interest: '4.4', fixedPart: '4.4' }),
          period(2, { rateSource: 'TERMS', addend: null, interest: '4.4', fixedPart: '4.4' }),
          period(3, { rateSource: 'TERMS', addend: null, interest: '4.4', fixedPart: '4.4' }),
        ],
        projectionAssumptions: [],
      });
      await mount();
      expect(screen.getAllByTestId('bar').map((b) => b.getAttribute('data-name'))).toEqual(['Fixed-rate interest']);
      expect(screen.queryByText(/1st period/)).not.toBeInTheDocument();
    });

    it('shows Matured, not Unknown, for a matured lot and keeps the period of an open lot with an unknown rate', async () => {
      get.mockResolvedValue(
        response({
          lots: [
            {
              purchaseDate: '2020-10-05',
              quantity: 10,
              purchaseDateAssumed: false,
              valuation: lotValuation({
                status: 'MATURED',
                currentPeriod: null,
                earlyRedemptionValue: null,
                earlyRedemptionRefusal: 'MATURED',
              }),
            },
            {
              purchaseDate: '2026-10-05',
              quantity: 5,
              purchaseDateAssumed: false,
              valuation: lotValuation({
                currentPeriod: {
                  index: 3,
                  start: '2027-01-01',
                  end: '2027-12-31',
                  annualRate: null,
                  rateSource: null,
                },
              }),
            },
          ],
        }),
      );
      await mount();
      const matured = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
      expect(matured[3]).toHaveTextContent('Matured');
      expect(matured[4]).toHaveTextContent('Matured');
      expect(matured[3]).not.toHaveTextContent('Unknown');
      const open = within(screen.getAllByRole('row')[2]).getAllByRole('cell');
      expect(open[3]).toHaveTextContent('3: 12/31/2027'.slice(0, 2));
      expect(open[3]).toHaveTextContent('01/01/2027');
      expect(open[4]).toHaveTextContent('Unknown');
    });

    it('shows the refusal reason of a lot bought outside the sale window instead of Unknown', async () => {
      get.mockResolvedValue(
        response({
          lots: [
            {
              purchaseDate: '2026-12-05',
              quantity: 10,
              purchaseDateAssumed: false,
              valuation: lotValuation({
                status: 'REFUSED',
                currentPeriod: null,
                refusal: {
                  code: 'PURCHASE_OUTSIDE_SALE_WINDOW',
                  params: { from: '2026-10-01', to: '2026-10-31', purchaseDate: '2026-12-05' },
                },
                grossValue: null,
                valuationComplete: false,
              }),
            },
          ],
        }),
      );
      await mount();
      const cell = within(screen.getAllByRole('row')[1]).getAllByRole('cell')[3];
      expect(cell).toHaveTextContent('Not valued');
      expect(cell).toHaveTextContent('can only be bought from 10/01/2026 to 10/31/2026');
      expect(cell).toHaveTextContent('bought on 12/05/2026');
    });

    it('shows a partial-data notice naming the cause when valuationComplete is false', async () => {
      withLots({
        valuationComplete: false,
        dataCompleteness: {
          termsComplete: false,
          referenceDataComplete: true,
          earlyRedemptionTermsComplete: true,
        },
        missing: [],
      });
      await mount();
      const note = screen.getByText('This valuation is incomplete', { exact: false }).closest('[role="note"]') as HTMLElement;
      expect(note).toHaveTextContent('This valuation is incomplete');
      expect(note).toHaveTextContent('The terms of the bond are incomplete');
      expect(note).not.toHaveTextContent('Reference data is missing');
    });

    it('shows no partial notice for a complete valuation or an absent flag', async () => {
      withLots({ valuationComplete: true });
      await mount();
      expect(screen.queryByText('This valuation is incomplete', { exact: false })).not.toBeInTheDocument();
    });

    it('says how fresh each benchmark is', async () => {
      get.mockResolvedValue(
        response({
          benchmarkCoverage: [
            { benchmarkId: CPI, coveredThrough: '2027-03-31', lastFetchedAt: '2027-04-10T06:00:00Z' },
            { benchmarkId: 'PL_NBP_REFERENCE', coveredThrough: null, lastFetchedAt: null },
          ],
        }),
      );
      await mount();
      expect(screen.getByText('CPI, 12 months (GUS) data as of 03/31/2027')).toBeInTheDocument();
      expect(screen.getByText('No NBP reference rate data is stored yet')).toBeInTheDocument();
    });

    it('translates a known issuer and falls back to the code for an unknown one', async () => {
      get.mockResolvedValue(
        response({
          instrument: {
            id: 'bond-1',
            issuerCountryCode: 'XX',
            issuerCode: 'XX_ISSUER',
            programCode: 'RETAIL',
            seriesCode: 'S1',
            currencyCode: 'PLN',
          },
        }),
      );
      await mount();
      expect(screen.getByText('Series S1 (XX_ISSUER, RETAIL, XX)')).toBeInTheDocument();
    });

    it('does not let the picker choose a day after today and never requests one', async () => {
      await mount();
      const input = screen.getByLabelText('Valued on');
      expect(input).toHaveAttribute('max', '2027-04-15');
      await act(async () => {
        fireEvent.change(input, { target: { value: '12/31/2030' } });
        fireEvent.blur(input);
      });
      expect(get).not.toHaveBeenCalledWith('sec-1', '2030-12-31', undefined);
    });

    it('values the scenarios on the card date and says so', async () => {
      withLots({});
      await mount();
      const input = screen.getByLabelText('Valued on');
      scenarios.mockResolvedValue({
        securityId: 'sec-1',
        benchmarkId: CPI,
        asOf: '2027-02-01',
        refusal: null,
        scenarios: scenarioRows,
      });
      await act(async () => {
        fireEvent.change(input, { target: { value: '02/01/2027' } });
        fireEvent.blur(input);
      });
      expect(scenarios).toHaveBeenLastCalledWith('sec-1', CPI, ['0', '0.025', '0.05', '0.08'], '2027-02-01');
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByText(/Valued on 02\/01\/2027/)).toBeInTheDocument();
    });
  });
});
