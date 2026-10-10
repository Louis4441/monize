import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityBondCard } from './SecurityBondCard';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';
import type {
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
});
