import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import { CALENDAR_MAX_PER_SCHEDULE } from '@/hooks/useCalendarMonthData';
import { TransactionsCalendarView } from './TransactionsCalendarView';
import calendarNs from '@/i18n/messages/en/calendar.json';
import { useViewModeStore } from '@/store/viewModeStore';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import { SCHEDULED_KIND_CHIP_CLASSES } from '@/lib/scheduled-kind';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import type { Account } from '@/types/account';
import type {
  ScheduledOccurrence,
  ScheduledTransaction,
} from '@/types/scheduled-transaction';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/transactions',
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

const mockGetAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAllPages: (...args: unknown[]) => mockGetAllPages(...args),
  },
}));

const mockGetOccurrences = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getOccurrences: (...args: unknown[]) => mockGetOccurrences(...args),
  },
}));

const TODAY = '2026-06-15';

const accounts = [
  { id: 'chequing-1', accountType: 'CHEQUING', linkedAccountId: null },
  { id: 'card-1', accountType: 'CREDIT_CARD', linkedAccountId: null },
  { id: 'brokerage-1', accountType: 'INVESTMENT', linkedAccountId: 'sleeve-1' },
  { id: 'sleeve-1', accountType: 'CASH', linkedAccountId: null },
] as unknown as Account[];

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'chequing-1',
    transactionDate: '2026-06-10',
    amount: -25,
    currencyCode: 'CAD',
    status: TransactionStatus.CLEARED,
    payeeName: 'Grocer',
    ...overrides,
  } as Transaction;
}

function schedule(overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return {
    id: 'st-1',
    name: 'Rent',
    amount: -1200,
    currencyCode: 'CAD',
    accountId: 'chequing-1',
    settlementAccountId: 'chequing-1',
    isTransfer: false,
    isInvestment: false,
    ...overrides,
  } as ScheduledTransaction;
}

function occurrence(overrides: Partial<ScheduledOccurrence> = {}): ScheduledOccurrence {
  return {
    scheduledTransactionId: 'st-1',
    originalDate: '2026-06-20',
    dueDate: '2026-06-20',
    amount: -1200,
    amountComplete: true,
    directionAmount: -1200,
    currencyCode: 'CAD',
    overrideId: null,
    moved: false,
    accountId: 'chequing-1',
    transferAccountId: null,
    isTransfer: false,
    ...overrides,
  };
}

const onEditTransaction = vi.fn();
const onCreateOnDay = vi.fn();

function renderView(
  overrides: Partial<React.ComponentProps<typeof TransactionsCalendarView>> = {},
) {
  return render(
    <TransactionsCalendarView
      accounts={accounts}
      scheduledTransactions={[schedule()]}
      filters={{ accountIds: ['chequing-1', 'card-1'] }}
      scopeAccountIds={['chequing-1', 'card-1']}
      weekStartsOn={0}
      today={TODAY}
      categoryColorMap={new Map()}
      categoryIconMap={new Map()}
      categoryLabelMap={new Map()}
      onEditTransaction={onEditTransaction}
      onCreateOnDay={onCreateOnDay}
      {...overrides}
    />,
  );
}

/** The cell for a day, located by the accessible name MonthGrid gives it. */
function cell(label: string) {
  return screen.getByLabelText(label);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllPages.mockResolvedValue([]);
  mockGetOccurrences.mockResolvedValue([]);
  useViewModeStore.setState({
    surfaces: {
      transactions: { view: 'calendar', layers: ['transactions'] },
      investments: { view: 'table', layers: ['transactions'] },
    },
  });
});

describe('TransactionsCalendarView', () => {
  it('asks the register for the grid range, not for the month alone', async () => {
    renderView();

    await waitFor(() => expect(mockGetAllPages).toHaveBeenCalled());
    // June 2026 starts on a Monday, so a Sunday-start grid runs 31 May to 4 July.
    expect(mockGetAllPages.mock.calls[0][0]).toMatchObject({
      startDate: '2026-05-31',
      endDate: '2026-07-04',
      accountIds: ['chequing-1', 'card-1'],
    });
    expect(mockGetOccurrences).toHaveBeenCalledWith({
      through: '2026-07-04',
      maxPerSchedule: CALENDAR_MAX_PER_SCHEDULE,
    });
  });

  describe('the transactions layer', () => {
    it('puts a row on its own day, coloured by its account type', async () => {
      mockGetAllPages.mockResolvedValue([transaction()]);
      renderView();

      const chip = await screen.findByRole('button', { name: /Grocer/ });
      expect(within(cell('06/10/2026')).getByRole('button', { name: /Grocer/ })).toBe(chip);
      expect(chip.className).toContain(ACCOUNT_TYPE_META.CHEQUING.pillClass.split(' ')[0]);
    });

    it('strikes a void row through rather than dropping it', async () => {
      mockGetAllPages.mockResolvedValue([
        transaction({ status: TransactionStatus.VOID }),
      ]);
      renderView();

      const chip = await screen.findByRole('button', { name: /Grocer/ });
      expect(chip.className).toContain('line-through');
    });

    it('dims a row dated after the server today', async () => {
      mockGetAllPages.mockResolvedValue([
        transaction({ transactionDate: '2026-06-20' }),
      ]);
      renderView();

      const chip = await screen.findByRole('button', { name: /Grocer/ });
      expect(chip.className).toContain('opacity-60');
    });

    it('opens the register edit modal for the row the reader clicked', async () => {
      const row = transaction();
      mockGetAllPages.mockResolvedValue([row]);
      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /Grocer/ }));

      expect(onEditTransaction).toHaveBeenCalledWith(row);
    });
  });

  describe('the scheduled occurrences', () => {
    it('draws an occurrence with its name, its amount and a scheduled marker', async () => {
      mockGetOccurrences.mockResolvedValue([occurrence()]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(chip).toHaveTextContent('$-1200.00');
      expect(chip.className).toContain('border-dashed');
      expect(chip.className).toContain(SCHEDULED_KIND_CHIP_CLASSES.bill.split(' ')[0]);
      expect(within(chip).getByLabelText('Scheduled')).toBeInTheDocument();
    });

    it('links an occurrence to its schedule on Bills & Deposits', async () => {
      mockGetOccurrences.mockResolvedValue([occurrence()]);
      renderView();

      expect(await screen.findByRole('link', { name: /Rent/ })).toHaveAttribute(
        'href',
        '/bills?highlight=st-1',
      );
    });

    it('marks an occurrence due before today as overdue', async () => {
      mockGetOccurrences.mockResolvedValue([
        occurrence({ originalDate: '2026-06-05', dueDate: '2026-06-05' }),
      ]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(within(chip).getByLabelText('Overdue')).toBeInTheDocument();
    });

    it('shows an unpriceable occurrence as unknown, never as a number', async () => {
      mockGetOccurrences.mockResolvedValue([
        occurrence({ amount: null, amountComplete: false, directionAmount: null }),
      ]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(within(chip).getByTestId('unknown-amount')).toBeInTheDocument();
      expect(chip).not.toHaveTextContent('$');
      expect(chip.className).toContain(SCHEDULED_KIND_CHIP_CLASSES.unknown.split(' ')[0]);
    });

    it('places an occurrence on the day an override moved it to', async () => {
      mockGetOccurrences.mockResolvedValue([
        occurrence({ originalDate: '2026-06-20', dueDate: '2026-06-23', moved: true }),
      ]);
      renderView();

      const chip = await screen.findByRole('link', { name: /Rent/ });
      expect(within(cell('06/23/2026')).getByRole('link', { name: /Rent/ })).toBe(chip);
    });

    it('leaves out an occurrence whose money never touches the accounts in scope', async () => {
      mockGetOccurrences.mockResolvedValue([occurrence()]);
      renderView({ scopeAccountIds: ['card-1'], filters: { accountIds: ['card-1'] } });

      await waitFor(() => expect(mockGetOccurrences).toHaveBeenCalled());
      expect(screen.queryByRole('link', { name: /Rent/ })).not.toBeInTheDocument();
    });

    it('keeps an investment occurrence on the account its cash leaves', async () => {
      // INV-OCCURRENCE-003: the brokerage is not the account that pays.
      mockGetOccurrences.mockResolvedValue([
        occurrence({ scheduledTransactionId: 'st-inv', accountId: 'brokerage-1' }),
      ]);
      renderView({
        scheduledTransactions: [
          schedule({
            id: 'st-inv',
            name: 'Monthly buy',
            accountId: 'brokerage-1',
            isInvestment: true,
            investmentFundingAccountId: 'chequing-1',
            settlementAccountId: 'chequing-1',
          }),
        ],
        scopeAccountIds: ['chequing-1'],
      });

      expect(await screen.findByRole('link', { name: /Monthly buy/ })).toBeInTheDocument();
    });
  });

  describe('the day panel', () => {
    it('opens on the day the reader picked and lists what is on it', async () => {
      mockGetAllPages.mockResolvedValue([transaction()]);
      renderView();

      await screen.findByRole('button', { name: /Grocer/ });
      fireEvent.click(cell('06/10/2026'));

      const panel = await screen.findByRole('complementary', { name: '06/10/2026' });
      expect(within(panel).getByText('Grocer')).toBeInTheDocument();
    });

    it('starts a new transaction on the day it is showing', async () => {
      renderView();

      fireEvent.click(cell('06/10/2026'));
      fireEvent.click(
        await screen.findByRole('button', { name: 'New transaction on this day' }),
      );

      expect(onCreateOnDay).toHaveBeenCalledWith('2026-06-10');
    });

    it('says a day is empty rather than showing nothing at all', async () => {
      renderView();

      fireEvent.click(cell('06/10/2026'));

      expect(await screen.findByText('Nothing on this day.')).toBeInTheDocument();
    });
  });

  describe('the month', () => {
    it('opens on the month of the server today', async () => {
      renderView();
      // The caption is the reader's own date format, through `formatMonth`.
      expect(await screen.findByRole('heading', { name: '06/2026' })).toBeInTheDocument();
    });

    it('asks for the next month when the reader steps forward', async () => {
      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));

      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(2));
      expect(mockGetAllPages.mock.calls[1][0]).toMatchObject({
        startDate: '2026-06-28',
        endDate: '2026-08-01',
      });
    });
  });

  describe('when the month cannot be drawn', () => {
    it('withholds the layer past the row cap and says why', async () => {
      mockGetAllPages.mockResolvedValue(
        Array.from({ length: 1001 }, (_, i) =>
          transaction({ id: `tx-${i}`, payeeName: 'Grocer' }),
        ),
      );
      renderView();

      expect(await screen.findByText(/more than the 1,?000/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Grocer/ })).not.toBeInTheDocument();
    });

    it('renders a retryable failure, never an empty month', async () => {
      mockGetAllPages.mockRejectedValue(new Error('offline'));
      renderView();

      expect(await screen.findByText('This month could not be loaded.')).toBeInTheDocument();
      expect(screen.queryByRole('grid')).not.toBeInTheDocument();

      mockGetAllPages.mockResolvedValue([transaction()]);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('button', { name: /Grocer/ })).toBeInTheDocument();
    });
  });

  describe('a payload belongs to the request that produced it', () => {
    it('keeps the month the reader is on when an earlier request answers late', async () => {
      // A starts, B starts, B resolves, A resolves late -> B is still shown.
      let resolveJune: (rows: Transaction[]) => void = () => {};
      mockGetAllPages.mockImplementationOnce(
        () => new Promise<Transaction[]>((resolve) => { resolveJune = resolve; }),
      );
      mockGetAllPages.mockResolvedValue([
        transaction({ id: 'tx-july', transactionDate: '2026-07-08', payeeName: 'Julys row' }),
      ]);

      renderView();
      await waitFor(() => expect(mockGetAllPages).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
      expect(await screen.findByRole('button', { name: /Julys row/ })).toBeInTheDocument();

      await act(async () => {
        resolveJune([transaction({ id: 'tx-june', payeeName: 'Junes row' })]);
      });

      expect(screen.getByRole('button', { name: /Julys row/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Junes row/ })).not.toBeInTheDocument();
    });
  });

  describe('the scheduled half', () => {
    it('draws the month and names the gap when only the occurrences fail', async () => {
      // The occurrence endpoint refuses a `through` beyond five years, which
      // the toolbar's next-month button reaches. The register's rows arrived,
      // so a blank month with a retry button would hide what the reader asked
      // for -- and silence would read as "nothing is due".
      mockGetAllPages.mockResolvedValue([transaction()]);
      mockGetOccurrences.mockRejectedValue(new Error('through is beyond the horizon'));

      renderView();

      await waitFor(() =>
        expect(screen.getByText(calendarNs.banner.scheduledUnavailable)).toBeInTheDocument(),
      );
      expect(screen.getByRole('grid')).toBeInTheDocument();
      expect(screen.queryByText(calendarNs.errors.monthFailed)).not.toBeInTheDocument();
    });

    it('says so when the per-schedule cap cut a schedule short of the grid', async () => {
      mockGetAllPages.mockResolvedValue([]);
      mockGetOccurrences.mockResolvedValue(
        Array.from({ length: CALENDAR_MAX_PER_SCHEDULE }, () => occurrence()),
      );

      renderView();

      await waitFor(() =>
        expect(screen.getByText(calendarNs.banner.scheduledTruncated)).toBeInTheDocument(),
      );
    });

    it('stays quiet when every schedule came back whole', async () => {
      mockGetAllPages.mockResolvedValue([]);
      mockGetOccurrences.mockResolvedValue([occurrence()]);

      renderView();

      await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());
      expect(
        screen.queryByText(calendarNs.banner.scheduledUnavailable),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(calendarNs.banner.scheduledTruncated)).not.toBeInTheDocument();
    });
  });
});
