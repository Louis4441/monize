import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render';
import BondsPage from './page';
import { investmentsApi } from '@/lib/investments';
import toast from 'react-hot-toast';
import type {
  BondHistory,
  BondInstrumentSummary,
  BondOffer,
  BondProgramSummary,
  OfferSeries,
} from '@/types/bond';
import type { Security } from '@/types/investment';

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/securities/bonds',
  useSearchParams: () => nav.params,
}));
vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'PLN' }) };
});
// The security form is the existing creation flow; here it only has to show
// what it was opened with.
vi.mock('next/dynamic', () => ({
  default: () =>
    function SecurityFormStub(props: { defaults?: Record<string, string> }) {
      return <div data-testid="security-form" data-defaults={JSON.stringify(props.defaults)} />;
    },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children, data }: any) => (
    <div data-testid="line-chart" data-points={JSON.stringify(data)}>
      {children}
    </div>
  ),
  Line: ({ dataKey, type, connectNulls }: any) => (
    <i data-testid={`line-${dataKey}`} data-type={type} data-connect-nulls={String(connectNulls)} />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getBondOffer: vi.fn(),
    getBondHistory: vi.fn(),
    listBondInstruments: vi.fn(),
    listBondPrograms: vi.fn(),
    getSecurities: vi.fn(),
    fetchBondOffer: vi.fn(),
    createSecurity: vi.fn(),
  },
}));

const api = vi.mocked(investmentsApi);

const source = { provider: 'obligacjeskarbowe.pl', url: 'https://example.test/letter', document: 'Letter' };

function series(overrides: Partial<OfferSeries> & Pick<OfferSeries, 'instrumentId' | 'seriesCode'>): OfferSeries {
  return {
    issuerCountryCode: 'PL',
    issuerCode: 'PL_MF',
    programCode: 'EDO',
    currency: 'PLN',
    saleWindow: { from: '2026-10-01', to: '2026-10-31' },
    periodMonths: 12,
    periodCount: 10,
    rateRule: {
      type: 'INFLATION_PLUS_MARGIN_AS_RATE',
      benchmarkId: 'PL_CPI_GUS_YOY',
      annualRate: null,
      firstPeriodRate: '0.0560',
      addend: '0.0200',
      benchmarkFloor: null,
    },
    capitalization: 'COMPOUND_AT_PERIOD_END',
    redemption: null,
    termsSource: source,
    projection: {
      maturityValue: '150.1234',
      totalReturn: '0.5012',
      annualizedReturn: '0.0450',
      projected: true,
      assumptions: [
        { benchmarkId: 'PL_CPI_GUS_YOY', value: '0.0290', basis: 'LATEST_OBSERVATION', observation: '2026-08' },
      ],
      projectionMissing: [],
    },
    ...overrides,
  };
}

const edo = series({ instrumentId: 'i-edo', seriesCode: 'EDO1036' });
const ots = series({
  instrumentId: 'i-ots',
  seriesCode: 'OTS0127',
  programCode: 'OTS',
  periodMonths: 3,
  periodCount: 1,
  rateRule: { type: 'FIXED', benchmarkId: null, annualRate: '0.0300', firstPeriodRate: null, addend: null, benchmarkFloor: null },
  capitalization: 'NONE',
  projection: {
    maturityValue: '100.7500',
    totalReturn: '0.0075',
    annualizedReturn: '0.0300',
    projected: false,
    assumptions: [],
    projectionMissing: [],
  },
});
const coi = series({
  instrumentId: 'i-coi',
  seriesCode: 'COI1030',
  programCode: 'COI',
  periodCount: 4,
  capitalization: 'NONE',
  termsSource: { provider: 'obligacjeskarbowe.pl', url: 'javascript:alert(1)', document: 'Unsafe' },
  projection: {
    maturityValue: null,
    totalReturn: null,
    annualizedReturn: null,
    projected: false,
    assumptions: [],
    projectionMissing: [{ benchmarkId: 'PL_CPI_GUS_YOY', publisher: 'GUS' }],
  },
});

const offer: BondOffer = { countryCode: 'PL', today: '2026-10-11', series: [coi, ots, edo] };

const instruments: BondInstrumentSummary[] = [
  { id: 'i-coi', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'COI', seriesCode: 'COI1030', currencyCode: 'PLN', termsProvider: 'x' },
  { id: 'i-edo', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'EDO', seriesCode: 'EDO1036', currencyCode: 'PLN', termsProvider: 'x' },
];

function historySeries(code: string, from: string, rate: string, fee: string | null) {
  return {
    seriesCode: code,
    saleWindow: { from, to: from.slice(0, 8) + '28' },
    firstPeriodRate: rate,
    annualRate: null,
    addend: '0.0200',
    fee,
    proceedsFloor: 'FIRST_PERIOD' as const,
    termsVersion: 1,
    termsSource: source,
  };
}
const history: BondHistory = {
  countryCode: 'PL',
  programs: [
    {
      programCode: 'EDO',
      series: [
        historySeries('EDO0126', '2026-01-01', '0.0560', '2.00'),
        historySeries('EDO0226', '2026-02-01', '0.0570', '2.00'),
        historySeries('EDO0426', '2026-04-01', '0.0590', '3.00'),
      ],
      coverage: { from: '2026-01', to: '2026-04', missingMonths: ['2026-03'] },
    },
  ],
};

const programs: BondProgramSummary[] = [
  { id: 'p-edo', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'EDO', currency: 'PLN', seriesCount: 12, newestSeriesCode: 'EDO1036' },
  { id: 'p-ots', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'OTS', currency: 'PLN', seriesCount: 4, newestSeriesCode: 'OTS0127' },
];

const rowCodes = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent ?? '');

async function renderPage(query = '') {
  nav.params = new URLSearchParams(query);
  await act(async () => {
    render(<BondsPage />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getBondOffer.mockResolvedValue(offer);
  api.getBondHistory.mockResolvedValue(history);
  api.listBondInstruments.mockResolvedValue(instruments);
  api.listBondPrograms.mockResolvedValue(programs);
  api.getSecurities.mockResolvedValue([]);
});

describe('Treasury bonds page, On sale tab', () => {
  it('renders every series with its figures, the letter link and the coupons note', async () => {
    await renderPage();
    expect(await screen.findByText(/EDO1036/)).toBeInTheDocument();
    expect(api.getBondOffer).toHaveBeenCalledWith('PL', []);
    expect(screen.getByText('$150.12')).toBeInTheDocument();
    // The first-period rate, the annualized return.
    expect(screen.getAllByText('5.6%').length).toBeGreaterThan(0);
    expect(screen.getByText('4.5%')).toBeInTheDocument();
    expect(screen.getAllByText(/Coupons not reinvested/).length).toBeGreaterThan(0);
    const letters = screen.getAllByRole('link', { name: /Terms: / });
    const safe = letters.find((a) => a.getAttribute('href') === 'https://example.test/letter');
    expect(safe).toHaveAttribute('target', '_blank');
    expect(safe).toHaveAttribute('rel', 'noopener noreferrer');
    // A non-http(s) address is text, never a link.
    expect(letters.some((a) => a.getAttribute('href')?.startsWith('javascript'))).toBe(false);
    expect(screen.getByText('Terms: Unsafe')).toBeInTheDocument();
  });

  it('marks a figure resting on an assumption as projected, and an unknown one with its reason', async () => {
    await renderPage();
    await screen.findByText(/EDO1036/);
    // EDO is projected (3 figures); OTS and COI are not.
    expect(screen.getAllByText('Projected')).toHaveLength(3);
    const coiRow = screen.getByText('COI1030').closest('tr')!;
    expect(within(coiRow).getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
    expect(within(coiRow).getAllByText(/published by GUS/).length).toBeGreaterThan(0);
  });

  it('sorts by annualized return (unknown last), length and first-period rate', async () => {
    await renderPage();
    await screen.findByText(/EDO1036/);
    expect(rowCodes().map((c) => c.slice(0, 7))).toEqual(['EDO1036', 'OTS0127', 'COI1030']);

    fireEvent.click(screen.getByRole('columnheader', { name: /Length/ }));
    expect(rowCodes().map((c) => c.slice(0, 7))).toEqual(['OTS0127', 'COI1030', 'EDO1036']);

    fireEvent.click(screen.getByRole('columnheader', { name: /First period/ }));
    // Descending: 5.6% (EDO), 5.6% (COI), 3% (OTS), ties in the server's order.
    expect(rowCodes().map((c) => c.slice(0, 7))).toEqual(['COI1030', 'EDO1036', 'OTS0127']);

    fireEvent.click(screen.getByRole('columnheader', { name: /Annualized return/ }));
    fireEvent.click(screen.getByRole('columnheader', { name: /Annualized return/ }));
    // Ascending puts the unknown figure last, not first.
    expect(rowCodes().map((c) => c.slice(0, 7))).toEqual(['OTS0127', 'EDO1036', 'COI1030']);
  });

  it('prefills each benchmark with its latest value and month, then re-queries once after a pause', async () => {
    await renderPage();
    await screen.findByText(/EDO1036/);
    const input = screen.getByLabelText(/CPI, 12 months \(GUS\)/) as HTMLInputElement;
    expect(input.value).toBe('2.90');
    expect(screen.getByText(/Latest published value: 2.9% \(.*2026.*\)/)).toBeInTheDocument();

    api.getBondOffer.mockClear();
    api.getBondOffer.mockResolvedValue({
      ...offer,
      series: [
        {
          ...edo,
          projection: {
            ...edo.projection,
            maturityValue: '170.0000',
            assumptions: [{ benchmarkId: 'PL_CPI_GUS_YOY', value: '0.0400', basis: 'SUPPLIED', observation: null }],
          },
        },
      ],
    });
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.change(input, { target: { value: '4' } });
    // Nothing is sent while the reader is still typing.
    expect(api.getBondOffer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('$170.00')).toBeInTheDocument(), { timeout: 3000 });
    expect(api.getBondOffer).toHaveBeenCalledTimes(1);
    expect(api.getBondOffer).toHaveBeenCalledWith('PL', [
      { benchmarkId: 'PL_CPI_GUS_YOY', value: '0.0400' },
    ]);
    // The latest published value is still shown after the supplied one replaced it.
    expect(screen.getByText(/Latest published value: 2.9%/)).toBeInTheDocument();

    api.getBondOffer.mockClear();
    api.getBondOffer.mockResolvedValue(offer);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use the latest published values' }));
    });
    await waitFor(() => expect(api.getBondOffer).toHaveBeenCalledWith('PL', []), { timeout: 3000 });
  });

  it('says a failed request failed and retries', async () => {
    api.getBondOffer.mockRejectedValueOnce(new Error('boom'));
    await renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByText(/EDO1036/)).toBeInTheDocument();
  });

  it('opens the security form with the series\' program, its currency and type BOND', async () => {
    await renderPage();
    await screen.findByText(/EDO1036/);
    expect(screen.queryByTestId('security-form')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add OTS0127 to my portfolio' }));
    });
    const form = await screen.findByTestId('security-form');
    expect(JSON.parse(form.getAttribute('data-defaults')!)).toEqual({
      symbol: 'OTS',
      name: 'OTS: 3-month fixed-rate savings bonds',
      securityType: 'BOND',
      currencyCode: 'PLN',
      bondProgramId: 'p-ots',
    });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('goes to the security the reader already holds for the program instead of creating a second', async () => {
    api.getSecurities.mockResolvedValue([
      { id: 'sec-other', bondProgramId: 'p-ots' } as Security,
      { id: 'sec-edo', bondProgramId: 'p-edo' } as Security,
    ]);
    await renderPage();
    await screen.findByText(/EDO1036/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add EDO1036 to my portfolio' }));
    });
    expect(nav.push).toHaveBeenCalledWith('/securities/sec-edo');
    expect(screen.queryByTestId('security-form')).not.toBeInTheDocument();
  });

  it('says so when the program cannot be looked up, and opens nothing', async () => {
    api.listBondPrograms.mockResolvedValue([]);
    await renderPage();
    await screen.findByText(/EDO1036/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add EDO1036 to my portfolio' }));
    });
    expect(toast.error).toHaveBeenCalledWith('The bond program could not be looked up. Try again.');
    expect(screen.queryByTestId('security-form')).not.toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
  });

  describe('fetch the current offer now', () => {
    const fetchButton = () => screen.findByRole('button', { name: 'Fetch the current offer now' });

    it('reads the offer, reloads it and tells what happened', async () => {
      api.fetchBondOffer.mockResolvedValue({ listed: 5, stored: 2, alreadyStored: 3, failed: 0 });
      await renderPage();
      await screen.findByText(/EDO1036/);
      expect(api.getBondOffer).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.click(await fetchButton());
      });
      expect(api.fetchBondOffer).toHaveBeenCalledWith('PL');
      expect(toast.success).toHaveBeenCalledWith(
        'Offer fetched: 5 series listed, 2 newly stored, 3 already stored, 0 failed.',
      );
      await waitFor(() => expect(api.getBondOffer).toHaveBeenCalledTimes(2));
    });

    it('says the throttle\'s own message when the server answers 429, and does not reload', async () => {
      api.fetchBondOffer.mockRejectedValue({
        response: { status: 429, data: { message: 'Too many requests, try again in a minute' } },
      });
      await renderPage();
      await screen.findByText(/EDO1036/);
      await act(async () => {
        fireEvent.click(await fetchButton());
      });
      expect(toast.error).toHaveBeenCalledWith('Too many requests, try again in a minute');
      expect(toast.success).not.toHaveBeenCalled();
      expect(api.getBondOffer).toHaveBeenCalledTimes(1);
      // The button is usable again.
      expect(await fetchButton()).toBeEnabled();
    });

    it('does not send twice while one fetch is in flight', async () => {
      let resolve!: (v: { listed: number; stored: number; alreadyStored: number; failed: number }) => void;
      api.fetchBondOffer.mockReturnValue(new Promise((r) => (resolve = r)));
      await renderPage();
      await screen.findByText(/EDO1036/);
      const button = await fetchButton();
      await act(async () => {
        fireEvent.click(button);
        fireEvent.click(button);
      });
      expect(api.fetchBondOffer).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Fetching the current offer...' })).toBeDisabled();
      await act(async () => {
        resolve({ listed: 1, stored: 0, alreadyStored: 1, failed: 0 });
      });
    });

    it('is on the On sale tab only', async () => {
      await renderPage();
      await fetchButton();
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'History' }));
      });
      expect(
        screen.getByRole('button', { name: 'Fetch the current offer now', hidden: true }),
      ).not.toBeVisible();
    });
  });
});

describe('Treasury bonds page, History tab', () => {
  async function openHistory(query = '') {
    await renderPage(query);
    if (query === '') {
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'History' }));
      });
    }
  }

  it('does not fetch the history until its tab is opened', async () => {
    await renderPage();
    await screen.findByText(/EDO1036/);
    expect(api.getBondHistory).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'On sale' })).toHaveAttribute('aria-selected', 'true');
  });

  it('draws the rate, margin and step fee charts with a gap for the missing month', async () => {
    await openHistory();
    // The mock holds no COI series: said so, not drawn as a chart.
    expect(await screen.findByText('No series of this product is stored yet.')).toBeInTheDocument();
    // The first product in the catalog, sorted.
    expect(api.getBondHistory).toHaveBeenCalledWith('PL', 'COI');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'EDO' } });
    });
    await screen.findByText('EDO0426');
    expect(api.getBondHistory).toHaveBeenLastCalledWith('PL', 'EDO');

    const charts = screen.getAllByTestId('line-chart');
    expect(charts).toHaveLength(2);
    const points = JSON.parse(charts[0].getAttribute('data-points')!);
    expect(points.map((p: { month: string }) => p.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
    // March is a null point, not an interpolation.
    expect(points[2]).toMatchObject({ month: '2026-03', rate: null, addend: null, fee: null });
    expect(points[0]).toMatchObject({ rate: 5.6, addend: 2, fee: 2 });
    for (const key of ['rate', 'addend', 'fee']) {
      expect(screen.getByTestId(`line-${key}`)).toHaveAttribute('data-connect-nulls', 'false');
    }
    expect(screen.getByTestId('line-fee')).toHaveAttribute('data-type', 'stepAfter');
  });

  it('lists the missing months and a table row for every series', async () => {
    await openHistory('tab=history&program=EDO');
    await screen.findByText('EDO0426');
    expect(api.getBondHistory).toHaveBeenCalledWith('PL', 'EDO');
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Months missing from the catalog (1)');
    expect(note).toHaveTextContent(/Mar.*2026/);
    for (const code of ['EDO0126', 'EDO0226', 'EDO0426']) {
      expect(screen.getByText(code)).toBeInTheDocument();
    }
    expect(screen.getAllByText('First period only').length).toBe(3);
  });

  it('says a failed history request failed instead of drawing an empty history', async () => {
    api.getBondHistory.mockRejectedValue(new Error('boom'));
    await openHistory('tab=history&program=EDO');
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
  });
});
