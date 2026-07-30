import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeRecentTransactions } from './PayeeRecentTransactions';
import type { Transaction } from '@/types/transaction';

const mockGetAll = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => mockGetAll(...args),
  },
}));

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'acct-1',
    account: { id: 'acct-1', name: 'Chequing' },
    transactionDate: '2026-07-15',
    payeeId: 'payee-1',
    payeeName: 'Starbucks',
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Coffee' },
    amount: -6.45,
    currencyCode: 'CAD',
    ...overrides,
  } as Transaction;
}

async function renderPanel(props: { refreshKey?: number } = {}) {
  const onViewAll = vi.fn();
  await act(async () => {
    render(
      <PayeeRecentTransactions
        payeeId="payee-1"
        refreshKey={props.refreshKey ?? 0}
        onViewAll={onViewAll}
      />,
    );
  });
  return { onViewAll };
}

describe('PayeeRecentTransactions', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
  });

  it('lists the latest transactions', async () => {
    mockGetAll.mockResolvedValue({
      data: [
        transaction(),
        transaction({ id: 'tx-2', category: null, amount: 25 }),
      ],
      pagination: { page: 1, limit: 10, total: 2, totalPages: 1, hasMore: false },
    });

    await renderPanel();

    expect(mockGetAll).toHaveBeenCalledWith({ payeeId: 'payee-1', limit: 10, page: 1 });
    expect(screen.getAllByText('Chequing')).toHaveLength(2);
    expect(screen.getByText('Coffee')).toBeInTheDocument();
    // A row without a category reads as uncategorized, not as blank.
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
  });

  it('shows the empty state for a payee with no transactions', async () => {
    mockGetAll.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0, hasMore: false },
    });

    await renderPanel();

    expect(screen.getByText('No transactions for this payee yet')).toBeInTheDocument();
  });

  it('reports a load failure without crashing the tab', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));

    await renderPanel();
    await act(async () => {});

    expect(screen.getByText('Failed to load transactions')).toBeInTheDocument();
  });

  it('links out to the full register', async () => {
    mockGetAll.mockResolvedValue({
      data: [transaction()],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });

    const { onViewAll } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'View all in the register' }));
    expect(onViewAll).toHaveBeenCalled();
  });
});
