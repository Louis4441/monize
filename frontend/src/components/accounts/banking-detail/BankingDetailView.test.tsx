import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { BankingDetailView } from './BankingDetailView';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: () => <div data-testid="balance-history-chart" />,
}));

const mockGetDailyBalances = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getDailyBalances: (...a: unknown[]) => mockGetDailyBalances(...a) },
}));

const mockGetSummary = vi.fn();
const mockGetMonthlyTotals = vi.fn();
const mockGetGroupedTotals = vi.fn();
const mockGetAll = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getSummary: (...a: unknown[]) => mockGetSummary(...a),
    getMonthlyTotals: (...a: unknown[]) => mockGetMonthlyTotals(...a),
    getGroupedTotals: (...a: unknown[]) => mockGetGroupedTotals(...a),
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getRecurringCharges: (...a: unknown[]) => mockGetRecurringCharges(...a),
  },
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'chq-1',
    accountType: 'CHEQUING',
    name: 'Everyday Chequing',
    currencyCode: 'CAD',
    currentBalance: 1500,
    interestRate: 1.5,
    ...overrides,
  } as Account;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDailyBalances.mockResolvedValue([
    { date: '2026-06-01', balance: 1000 },
    { date: '2026-06-15', balance: 1500 },
  ]);
  mockGetSummary.mockResolvedValue({
    totalIncome: 2000,
    totalExpenses: 1500,
    netCashFlow: 500,
    transactionCount: 8,
  });
  mockGetMonthlyTotals.mockResolvedValue([{ month: '2026-06', total: 500, count: 3 }]);
  mockGetGroupedTotals.mockImplementation((params: { groupBy: string }) =>
    Promise.resolve(
      params.groupBy === 'payee'
        ? [{ id: 'p1', name: 'Corner Store', currencyCode: 'CAD', total: -300, count: 3 }]
        : [{ id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 }],
    ),
  );
  mockGetAll.mockResolvedValue({ data: [], pagination: {} });
  mockGetRecurringCharges.mockResolvedValue([]);
});

async function renderView(account = makeAccount()) {
  await act(async () => {
    render(<BankingDetailView account={account} />);
  });
}

describe('BankingDetailView', () => {
  it('renders summary figures', async () => {
    await renderView();
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Projected Balance')).toBeInTheDocument();
    expect(screen.getByText('Money In')).toBeInTheDocument();
    expect(screen.getByText('Money Out')).toBeInTheDocument();
    expect(screen.getByText('Average Balance')).toBeInTheDocument();
    // Interest rate card appears because the account has a rate.
    expect(screen.getByText('1.5%')).toBeInTheDocument();
  });

  it('projects the balance from the last daily-balance point', async () => {
    await renderView();
    await waitFor(() => expect(mockGetDailyBalances).toHaveBeenCalled());
    // Projected balance = last daily balance (1500); average = (1000+1500)/2 = 1250.
    expect(screen.getByText('$1250.00')).toBeInTheDocument();
  });

  it('renders the cash-flow report and top categories', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.getByText('Corner Store')).toBeInTheDocument();
    expect(screen.getByText('Cash Flow')).toBeInTheDocument();
    expect(screen.getByText('Top Categories')).toBeInTheDocument();
    expect(screen.getByText('Top Payees')).toBeInTheDocument();
  });

  it('detects interest earned YTD by category name', async () => {
    // Order of grouped-totals calls: category (month), payee (month), category (YTD).
    mockGetGroupedTotals
      .mockResolvedValueOnce([{ id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 }])
      .mockResolvedValueOnce([{ id: 'p1', name: 'Store', currencyCode: 'CAD', total: -450, count: 5 }])
      .mockResolvedValueOnce([
        { id: 'i1', name: 'Interest Income', currencyCode: 'CAD', total: 12.34, count: 4 },
      ]);
    await renderView();
    await waitFor(() => expect(screen.getByText('Interest Earned')).toBeInTheDocument());
    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });
});
