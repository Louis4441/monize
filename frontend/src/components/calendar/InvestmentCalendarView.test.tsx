import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@/test/render';
import { InvestmentCalendarView } from './InvestmentCalendarView';
import calendarNs from '@/i18n/messages/en/calendar.json';
import { useViewModeStore } from '@/store/viewModeStore';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import type { Account } from '@/types/account';
import type { InvestmentTransaction } from '@/types/investment';
import type { DailyInvestmentValue } from '@/types/net-worth';
import type { DailyMovementPoint, DailyMovementsResponse } from '@/types/investment';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/investments',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      defaultCurrency: 'CAD',
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD', rates: [], getMarketRate: () => null }),
}));

const mockGetAllTransactionPages = vi.fn();
const mockGetDailyMovements = vi.fn();
const mockGetDailyMovementDetail = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getAllTransactionPages: (...args: unknown[]) => mockGetAllTransactionPages(...args),
    getDailyMovements: (...args: unknown[]) => mockGetDailyMovements(...args),
    getDailyMovementDetail: (...args: unknown[]) => mockGetDailyMovementDetail(...args),
  },
}));

const mockGetAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getAllPages: (...args: unknown[]) => mockGetAllPages(...args) },
}));

const mockGetInvestmentsDaily = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsDaily: (...args: unknown[]) => mockGetInvestmentsDaily(...args) },
}));

const TODAY = '2026-06-15';

const accounts = [
  { id: 'brokerage-1', accountType: 'INVESTMENT', linkedAccountId: 'sleeve-1' },
  { id: 'sleeve-1', accountType: 'CASH', linkedAccountId: null },
] as unknown as Account[];

function brokerageRow(overrides: Partial<InvestmentTransaction> = {}): InvestmentTransaction {
  return {
    id: 'inv-1',
    accountId: 'brokerage-1',
    action: 'BUY',
    transactionDate: '2026-06-10',
    totalAmount: 505,
    quantity: 10,
    price: 50,
    commission: 5,
    status: TransactionStatus.CLEARED,
    security: { id: 'sec-1', symbol: 'ABC', name: 'ABC Corp', currencyCode: 'CAD' },
    ...overrides,
  } as InvestmentTransaction;
}

function cashRow(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'cash-1',
    accountId: 'sleeve-1',
    transactionDate: '2026-06-11',
    amount: 1000,
    currencyCode: 'CAD',
    status: TransactionStatus.CLEARED,
    payeeName: 'Payroll',
    ...overrides,
  } as Transaction;
}

function valuePoint(
  date: string,
  overrides: Partial<DailyInvestmentValue> = {},
): DailyInvestmentValue {
  return {
    date,
    value: 100000,
    fxComplete: true,
    pricesComplete: true,
    missingRatePairs: [],
    unpricedSecurityIds: [],
    ...overrides,
  };
}

function movementPoint(
  date: string,
  overrides: Partial<DailyMovementPoint> = {},
): DailyMovementPoint {
  return {
    date,
    isTradingDay: true,
    movement: 200,
    movementPercent: 0.2,
    complete: true,
    reasons: [],
    ...overrides,
  };
}

function movements(days: DailyMovementPoint[]): DailyMovementsResponse {
  return { currencyCode: 'CAD', today: TODAY, days };
}

const onEditInvestment = vi.fn();
const onEditCashTransaction = vi.fn();
const onCreateOnDay = vi.fn();

function renderView(
  overrides: Partial<React.ComponentProps<typeof InvestmentCalendarView>> = {},
) {
  return render(
    <InvestmentCalendarView
      accounts={accounts}
      brokerageAccountIds={['brokerage-1']}
      cashAccountIds={['sleeve-1']}
      weekStartsOn={0}
      today={TODAY}
      onEditInvestment={onEditInvestment}
      onEditCashTransaction={onEditCashTransaction}
      onCreateOnDay={onCreateOnDay}
      {...overrides}
    />,
  );
}

/** The cell for a day, located by the accessible name MonthGrid gives it. */
function cell(label: string) {
  return screen.getByLabelText(label);
}

function withLayers(...layers: Array<'transactions' | 'values' | 'dailyChange'>) {
  useViewModeStore.setState({
    surfaces: {
      transactions: { view: 'table', layers: ['transactions'] },
      investments: { view: 'calendar', layers },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllTransactionPages.mockResolvedValue([]);
  mockGetAllPages.mockResolvedValue([]);
  mockGetInvestmentsDaily.mockResolvedValue([]);
  mockGetDailyMovements.mockResolvedValue(movements([]));
  mockGetDailyMovementDetail.mockResolvedValue({
    date: '2026-06-11',
    currencyCode: 'CAD',
    movement: 200,
    movementPercent: 0.2,
    complete: true,
    reasons: [],
    gains: [],
    losses: [],
    unchangedCount: 0,
    remainder: 200,
  });
  withLayers('transactions');
});

describe('InvestmentCalendarView', () => {
  it('asks both registers for the grid range', async () => {
    renderView();

    await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
    expect(mockGetAllTransactionPages).toHaveBeenCalledWith({
      accountIds: 'brokerage-1',
      startDate: '2026-05-31',
      endDate: '2026-07-04',
    });
    expect(mockGetAllPages).toHaveBeenCalledWith({
      accountIds: ['sleeve-1'],
      startDate: '2026-05-31',
      endDate: '2026-07-04',
    });
  });

  it('asks the cash register nothing when the page has no linked sleeve', async () => {
    renderView({ cashAccountIds: [] });

    await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
    expect(mockGetAllPages).not.toHaveBeenCalled();
  });

  describe('the transactions layer', () => {
    it('draws a trade with its symbol, its action and its total', async () => {
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      renderView();

      const chip = await screen.findByRole('button', { name: /ABC/ });
      expect(within(cell('06/10/2026')).getByRole('button', { name: /ABC/ })).toBe(chip);
      expect(chip).toHaveTextContent('$505.00');
      expect(chip.className).toContain(ACCOUNT_TYPE_META.INVESTMENT.pillClass.split(' ')[0]);
    });

    it('opens the investment edit modal for the trade the reader clicked', async () => {
      const row = brokerageRow();
      mockGetAllTransactionPages.mockResolvedValue([row]);
      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /ABC/ }));

      expect(onEditInvestment).toHaveBeenCalledWith(row);
    });

    it('drops a cash leg whose trade is on screen, and keeps the trade (I5)', async () => {
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      mockGetAllPages.mockResolvedValue([
        cashRow({
          id: 'cash-leg',
          transactionDate: '2026-06-10',
          payeeName: 'ABC purchase',
          linkedInvestmentTransactionId: 'inv-1',
        }),
      ]);
      renderView();

      await screen.findByRole('button', { name: /ABC Buy/ });
      expect(screen.queryByRole('button', { name: /ABC purchase/ })).not.toBeInTheDocument();
    });

    it('keeps a cash leg whose trade is out of scope (I5)', async () => {
      mockGetAllTransactionPages.mockResolvedValue([]);
      mockGetAllPages.mockResolvedValue([
        cashRow({
          id: 'cash-leg',
          payeeName: 'ABC purchase',
          linkedInvestmentTransactionId: 'inv-1',
        }),
      ]);
      renderView();

      expect(await screen.findByRole('button', { name: /ABC purchase/ })).toBeInTheDocument();
    });

    it('keeps an ordinary cash deposit and opens the cash modal for it', async () => {
      const row = cashRow();
      mockGetAllPages.mockResolvedValue([row]);
      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /Payroll/ }));

      expect(onEditCashTransaction).toHaveBeenCalledWith(row);
    });

    it('starts a trade on the day the panel is showing', async () => {
      renderView();

      fireEvent.click(cell('06/10/2026'));
      fireEvent.click(
        await screen.findByRole('button', {
          name: calendarNs.day.newInvestmentTransaction,
        }),
      );

      expect(onCreateOnDay).toHaveBeenCalledWith('2026-06-10');
    });
  });

  describe('the values layer', () => {
    it('asks only for days up to today, whatever the grid shows', async () => {
      withLayers('transactions', 'values');
      renderView();

      await waitFor(() => expect(mockGetInvestmentsDaily).toHaveBeenCalled());
      expect(mockGetInvestmentsDaily).toHaveBeenCalledWith({
        startDate: '2026-05-31',
        endDate: TODAY,
        accountIds: 'brokerage-1',
        displayCurrency: undefined,
      });
    });

    it('prints a value on a day it knows and nothing after today', async () => {
      withLayers('transactions', 'values');
      mockGetInvestmentsDaily.mockResolvedValue([valuePoint('2026-06-15')]);
      renderView();

      expect(
        await within(cell('06/15/2026')).findByTestId('calendar-value-figure'),
      ).toHaveTextContent('$100000.00');
      // Decision 7: a market value is never projected, so a future day is blank
      // rather than unknown.
      expect(within(cell('06/20/2026')).queryByTestId('calendar-value-figure')).toBeNull();
      expect(within(cell('06/20/2026')).queryByTestId('unknown-amount')).toBeNull();
    });

    it('shows unknown, not a subtotal, when a holding had no price (example 6)', async () => {
      withLayers('transactions', 'values');
      mockGetInvestmentsDaily.mockResolvedValue([
        valuePoint('2026-06-15', {
          value: 40000,
          pricesComplete: false,
          unpricedSecurityIds: ['sec-1'],
        }),
      ]);
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      renderView();

      const dayCell = cell('06/15/2026');
      await waitFor(() =>
        expect(within(dayCell).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      expect(dayCell).not.toHaveTextContent('40000');

      // The banner names the security by its symbol, which is a price the
      // reader can add.
      expect(screen.getByText(/ABC/, { selector: 'li' })).toBeInTheDocument();

      fireEvent.click(dayCell);
      const panel = await screen.findByRole('complementary', { name: '06/15/2026' });
      expect(within(panel).getByText(/No price is available for ABC/)).toBeInTheDocument();
    });

    it('shows unknown and names the pair when a rate is missing', async () => {
      withLayers('transactions', 'values');
      mockGetInvestmentsDaily.mockResolvedValue([
        valuePoint('2026-06-15', {
          fxComplete: false,
          missingRatePairs: ['USD->CAD'],
        }),
      ]);
      renderView();

      await waitFor(() =>
        expect(within(cell('06/15/2026')).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      fireEvent.click(cell('06/15/2026'));
      const panel = await screen.findByRole('complementary', { name: '06/15/2026' });
      expect(within(panel).getByText(/USD->CAD/)).toBeInTheDocument();
    });

    it('reads an absent completeness flag as no information, never as withheld', async () => {
      withLayers('transactions', 'values');
      // An older backend mid-deploy sends neither flag.
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2026-06-15', value: 100000 } as DailyInvestmentValue,
      ]);
      renderView();

      expect(
        await within(cell('06/15/2026')).findByTestId('calendar-value-figure'),
      ).toBeInTheDocument();
    });

    it('asks nothing while the layer is off', async () => {
      renderView();

      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
      expect(mockGetInvestmentsDaily).not.toHaveBeenCalled();
    });

    it('leaves the transactions layer intact when only the values request fails', async () => {
      withLayers('transactions', 'values');
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      mockGetInvestmentsDaily.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText(calendarNs.errors.valuesFailed)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /ABC/ })).toBeInTheDocument();
    });
  });

  describe('when the month cannot be drawn', () => {
    it('withholds the layer past the row cap and says why', async () => {
      mockGetAllTransactionPages.mockResolvedValue(
        Array.from({ length: 1001 }, (_, i) => brokerageRow({ id: `inv-${i}` })),
      );
      renderView();

      expect(await screen.findByText(/more than the 1,?000/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /ABC/ })).not.toBeInTheDocument();
    });

    it('renders a retryable failure, never an empty month', async () => {
      mockGetAllTransactionPages.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText(calendarNs.errors.monthFailed)).toBeInTheDocument();
      expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    });
  });
  describe('the daily change layer', () => {
    it('asks only for days up to today', async () => {
      withLayers('dailyChange');
      renderView();

      await waitFor(() => expect(mockGetDailyMovements).toHaveBeenCalled());
      expect(mockGetDailyMovements).toHaveBeenCalledWith({
        startDate: '2026-05-31',
        endDate: TODAY,
        accountIds: 'brokerage-1',
        displayCurrency: undefined,
      });
    });

    it('prints a complete day as a percentage (table B)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(movements([movementPoint('2026-06-11')]));
      renderView();

      const figure = await within(cell('06/11/2026')).findByTestId('calendar-change-figure');
      expect(figure).toHaveTextContent('0.20%');
      expect(figure.className).toContain('text-green-600');
    });

    it('colours a fall red and a flat session neutral', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-10', { movement: -100, movementPercent: -0.1 }),
          movementPoint('2026-06-11', { movement: 0, movementPercent: 0 }),
        ]),
      );
      renderView();

      const fall = await within(cell('06/10/2026')).findByTestId('calendar-change-figure');
      expect(fall.className).toContain('text-red-600');
      // Exactly zero is not a gain: a session that did not move is neutral.
      const flat = within(cell('06/11/2026')).getByTestId('calendar-change-figure');
      expect(flat.className).toContain('text-gray-500');
      expect(flat.className).not.toContain('text-green-600');
    });

    it('leaves a non-trading day blank, with no unknown marker (example 4)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-13', {
            isTradingDay: false,
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['notTradingDay'],
          }),
        ]),
      );
      renderView();

      await waitFor(() => expect(mockGetDailyMovements).toHaveBeenCalled());
      const saturday = cell('06/13/2026');
      expect(within(saturday).queryByTestId('calendar-change-figure')).toBeNull();
      expect(within(saturday).queryByTestId('unknown-amount')).toBeNull();
    });

    it('leaves a zero-baseline day blank rather than unknown (example 5)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-11', {
            movementPercent: null,
            complete: false,
            reasons: ['zeroBaseline'],
          }),
        ]),
      );
      renderView();

      await waitFor(() => expect(mockGetDailyMovements).toHaveBeenCalled());
      const day = cell('06/11/2026');
      expect(within(day).queryByTestId('calendar-change-figure')).toBeNull();
      expect(within(day).queryByTestId('unknown-amount')).toBeNull();
    });

    it('marks an unpriced trading day unknown (example 6)', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(
        movements([
          movementPoint('2026-06-11', {
            movement: null,
            movementPercent: null,
            complete: false,
            reasons: ['unpricedHolding'],
          }),
        ]),
      );
      renderView();

      await waitFor(() =>
        expect(within(cell('06/11/2026')).getByTestId('unknown-amount')).toBeInTheDocument(),
      );
      expect(within(cell('06/11/2026')).queryByTestId('calendar-change-figure')).toBeNull();
    });

    it('opens the breakdown for the day whose percentage was clicked', async () => {
      withLayers('dailyChange');
      mockGetDailyMovements.mockResolvedValue(movements([movementPoint('2026-06-11')]));
      renderView();

      fireEvent.click(
        await within(cell('06/11/2026')).findByTestId('calendar-change-figure'),
      );

      await waitFor(() => expect(mockGetDailyMovementDetail).toHaveBeenCalled());
      expect(mockGetDailyMovementDetail).toHaveBeenCalledWith({
        date: '2026-06-11',
        accountIds: 'brokerage-1',
        displayCurrency: undefined,
      });
    });

    it('asks nothing while the layer is off', async () => {
      renderView();

      await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());
      expect(mockGetDailyMovements).not.toHaveBeenCalled();
    });

    it('leaves the other layers intact when only the movements request fails', async () => {
      withLayers('transactions', 'dailyChange');
      mockGetAllTransactionPages.mockResolvedValue([brokerageRow()]);
      mockGetDailyMovements.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText(calendarNs.errors.movementsFailed)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /ABC/ })).toBeInTheDocument();
    });
  });
});
