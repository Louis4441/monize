import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import toast from 'react-hot-toast';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'PLN' }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    getRate: () => null,
    rates: [],
    rateMap: new Map(),
    isLoading: false,
    convert: (amount: number) => amount,
    convertToDefault: (amount: number) => amount,
    refresh: vi.fn(),
    defaultCurrency: 'PLN',
  }),
}));
vi.mock('@/lib/format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/format')>();
  return { ...actual, getCurrencySymbol: () => 'zl' };
});
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn(),
    getHoldings: vi.fn().mockResolvedValue([]),
    getHoldingAt: vi.fn().mockResolvedValue({ quantity: 0, averageCost: 0 }),
    createTransaction: vi.fn().mockResolvedValue({}),
    updateTransaction: vi.fn().mockResolvedValue({}),
    listBondPrograms: vi.fn(),
    listBondInstruments: vi.fn(),
    fetchBondSeries: vi.fn(),
    getSecurityBondValuation: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (data: any) => ({ values: data, errors: {} }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/securities/SecurityForm', () => ({ SecurityForm: () => null }));

const api = vi.mocked(investmentsApi);

const account = {
  id: 'a1',
  name: 'IKE Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  currencyCode: 'PLN',
} as any;

const securities = [
  { id: 'sec-edo', symbol: 'EDO', name: 'EDO', securityType: 'BOND', currencyCode: 'PLN', bondProgramId: 'p-edo' },
  { id: 'sec-tos', symbol: 'TOS', name: 'TOS', securityType: 'BOND', currencyCode: 'PLN', bondProgramId: 'p-tos' },
  { id: 'sec-stock', symbol: 'CDR', name: 'CD Projekt', securityType: 'STOCK', currencyCode: 'PLN', bondProgramId: null },
];
const programs = [
  { id: 'p-edo', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'EDO', currency: 'PLN', seriesCount: 2, newestSeriesCode: 'EDO1036' },
  { id: 'p-tos', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'TOS', currency: 'PLN', seriesCount: 1, newestSeriesCode: 'TOS1029' },
];
const inst = (id: string, seriesCode: string, programCode = 'EDO') => ({
  id,
  issuerCountryCode: 'PL',
  issuerCode: 'PL_MF',
  programCode,
  seriesCode,
  currencyCode: 'PLN',
  termsProvider: 'curated',
});
const instruments = [inst('i-0936', 'EDO0936'), inst('i-1036', 'EDO1036'), inst('i-tos', 'TOS1029', 'TOS')];

const lot = (instrumentId: string, seriesCode: string) => ({
  instrumentId,
  purchaseDate: '2026-09-01',
  quantity: 5,
  purchaseDateAssumed: false,
  valuation: { seriesCode },
});

const optionLabels = (select: HTMLElement) =>
  within(select).getAllByRole('option').map((o) => o.textContent);

async function openForm(props: Record<string, unknown> = {}) {
  await act(async () => {
    render(
      <InvestmentTransactionForm accounts={[account]} defaultAccountId="a1" defaultDate="2026-10-12" {...props} />,
    );
  });
}

async function pickSecurity(id: string, action?: string) {
  if (action) {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: action } });
    });
  }
  await waitFor(() => expect(within(screen.getByLabelText('Security')).getAllByRole('option').length).toBeGreaterThan(1));
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Security'), { target: { value: id } });
  });
}

const seriesSelect = () => screen.findByLabelText('Bond series') as Promise<HTMLSelectElement>;

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByText('Create Transaction'));
  });
}
const sent = () => api.createTransaction.mock.calls[0][0] as any;

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecurities.mockResolvedValue(securities.map((s) => ({ ...s })) as any);
  api.listBondPrograms.mockResolvedValue(programs);
  api.listBondInstruments.mockResolvedValue(instruments);
  api.getSecurityBondValuation.mockResolvedValue({ lots: [lot('i-1036', 'EDO1036'), lot('i-0936', 'EDO0936'), lot('i-1036', 'EDO1036')] } as any);
  api.createTransaction.mockResolvedValue({} as any);
  api.updateTransaction.mockResolvedValue({} as any);
});

describe('InvestmentTransactionForm: the series of a bond program', () => {
  describe('an acquisition', () => {
    it('lists the program\'s stored series and prefills the one on sale on the transaction date', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-1036'));
      // Only this program's series, plus the date's inference.
      expect(optionLabels(select)).toEqual(['Determined from the date', 'EDO0936', 'EDO1036']);
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBe('i-1036');
      expect(sent().securityId).toBe('sec-edo');
    });

    it('sends the series the reader picked instead of the prefilled one', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-1036'));
      fireEvent.change(select, { target: { value: 'i-0936' } });
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBe('i-0936');
    });

    it('sends null when the reader leaves the series to the server', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-1036'));
      fireEvent.change(select, { target: { value: '' } });
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent()).toHaveProperty('bondInstrumentId', null);
    });

    it('prefills nothing, and sends null, when no stored series is the date\'s', async () => {
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO0936'));
      expect(select.value).toBe('');
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBeNull();
    });

    it('offers to fetch the date\'s series when it is missing, then selects and sends it', async () => {
      api.fetchBondSeries.mockResolvedValue({ ...inst('i-1136', 'EDO1136'), created: true } as any);
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      const fetchLabel = 'Fetch EDO1136 from the official source';
      await waitFor(() => expect(optionLabels(select)).toContain(fetchLabel));
      api.listBondInstruments.mockResolvedValue([...instruments, inst('i-1136', 'EDO1136')]);
      await act(async () => {
        fireEvent.change(select, { target: { value: within(select).getByText(fetchLabel).getAttribute('value') } });
      });
      expect(api.fetchBondSeries).toHaveBeenCalledWith('PL', 'EDO1136');
      await waitFor(() => expect(select.value).toBe('i-1136'));
      // Stored now, so there is nothing left to offer.
      expect(optionLabels(select)).not.toContain(fetchLabel);
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBe('i-1136');
    });

    it('says why a fetch failed, inline, and keeps the choice open', async () => {
      api.fetchBondSeries.mockRejectedValue({ response: { data: { message: 'Series EDO1136 is not published yet' } } });
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      const fetchLabel = 'Fetch EDO1136 from the official source';
      await waitFor(() => expect(optionLabels(select)).toContain(fetchLabel));
      await act(async () => {
        fireEvent.change(select, { target: { value: within(select).getByText(fetchLabel).getAttribute('value') } });
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('Series EDO1136 is not published yet');
      expect(select.value).toBe('');
      expect(optionLabels(select)).toContain(fetchLabel);
    });

    it('offers no fetch for a program whose series codes it cannot derive', async () => {
      api.listBondPrograms.mockResolvedValue([{ ...programs[0], programCode: 'ZZZ' }]);
      api.listBondInstruments.mockResolvedValue([inst('i-z', 'ZZZ0136', 'ZZZ')]);
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('ZZZ0136'));
      expect(optionLabels(select).some((l) => /Fetch/.test(l ?? ''))).toBe(false);
    });

    it('says a failed lookup failed, and retries', async () => {
      api.listBondInstruments.mockRejectedValueOnce(new Error('down'));
      await openForm();
      await pickSecurity('sec-edo');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The series could not be loaded.');
      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      });
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-1036'));
      expect(screen.queryByText('The series could not be loaded.')).not.toBeInTheDocument();
    });

    it('starts the choice again when another bond security is selected', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-1036'));
      fireEvent.change(select, { target: { value: 'i-0936' } });
      await pickSecurity('sec-tos');
      await waitFor(() => expect(optionLabels(screen.getByLabelText('Bond series'))).toEqual(['Determined from the date', 'TOS1029']));
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().securityId).toBe('sec-tos');
      expect(sent().bondInstrumentId).not.toBe('i-0936');
    });
  });

  describe('a removal', () => {
    it('lists the series of the security\'s lots with Oldest first as the default, and sends null', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toEqual(['Oldest first', 'EDO0936', 'EDO1036']));
      expect(api.getSecurityBondValuation).toHaveBeenCalledWith('sec-edo');
      expect(select.value).toBe('');
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().action).toBe('SELL');
      expect(sent()).toHaveProperty('bondInstrumentId', null);
    });

    it('sends the series the reader names, and offers no fetch', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO0936'));
      expect(optionLabels(select).some((l) => /Fetch/.test(l ?? ''))).toBe(false);
      fireEvent.change(select, { target: { value: 'i-0936' } });
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBe('i-0936');
    });

    it('names no series for a redemption of a bond with no lots open, and says the list is only oldest first', async () => {
      api.getSecurityBondValuation.mockResolvedValue({ lots: [] } as any);
      await openForm();
      await pickSecurity('sec-edo', 'REDEEM');
      const select = await seriesSelect();
      await waitFor(() => expect(api.getSecurityBondValuation).toHaveBeenCalled());
      expect(optionLabels(select)).toEqual(['Oldest first']);
    });
  });

  describe('where there is no series', () => {
    it('shows nothing for a security that is not program-linked, and sends no series', async () => {
      await openForm();
      await pickSecurity('sec-stock');
      expect(screen.queryByLabelText('Bond series')).not.toBeInTheDocument();
      expect(api.listBondInstruments).not.toHaveBeenCalled();
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBeUndefined();
    });

    it('shows nothing for an action that moves no shares', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'DIVIDEND');
      expect(screen.queryByLabelText('Bond series')).not.toBeInTheDocument();
    });
  });

  describe('the server\'s refusal', () => {
    const refuse = (errorCode: string, message: string) =>
      api.createTransaction.mockRejectedValue({ response: { status: 400, data: { message, errorCode } } });

    it('is said under the series select when it is about the series, and in a toast', async () => {
      refuse('SERIES_NOT_DETERMINED', 'No stored series of EDO covers 2026-11-05. Fetch the series first.');
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      await seriesSelect();
      await submit();
      expect(await screen.findByText('No stored series of EDO covers 2026-11-05. Fetch the series first.')).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('No stored series of EDO covers 2026-11-05. Fetch the series first.');
    });

    it('is cleared when the reader picks a series again', async () => {
      refuse('SERIES_NOT_IN_PROGRAM', 'That series is not a series of EDO.');
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-1036'));
      await submit();
      expect(await screen.findByText('That series is not a series of EDO.')).toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'i-0936' } });
      expect(screen.queryByText('That series is not a series of EDO.')).not.toBeInTheDocument();
    });

    it('is only a toast when it is about something else', async () => {
      refuse('SOMETHING_ELSE', 'Not enough cash.');
      await openForm();
      await pickSecurity('sec-edo');
      await seriesSelect();
      await submit();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not enough cash.'));
      expect(screen.queryByText('Not enough cash.')).not.toBeInTheDocument();
    });
  });

  describe('editing a row', () => {
    const row = {
      id: 't1',
      accountId: 'a1',
      securityId: 'sec-edo',
      action: 'BUY' as const,
      transactionDate: '2026-11-05',
      quantity: 5,
      price: 100,
      commission: 0,
      totalAmount: 500,
      description: '',
      bondInstrumentId: 'i-0936',
    } as any;

    it('keeps the row\'s own series, whatever the date would suggest', async () => {
      await openForm({ transaction: row, defaultDate: undefined });
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036'));
      expect(select.value).toBe('i-0936');
      await act(async () => {
        fireEvent.click(screen.getByText('Update Transaction'));
      });
      await waitFor(() => expect(api.updateTransaction).toHaveBeenCalled());
      expect(api.updateTransaction.mock.calls[0][1]).toMatchObject({ bondInstrumentId: 'i-0936' });
    });
  });
});
