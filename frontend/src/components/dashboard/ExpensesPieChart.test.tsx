import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@/test/render';
import { ExpensesPieChart } from './ExpensesPieChart';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAllPages: (...args: any[]) => mockGetAllPages(...args),
  },
}));

// Fixed config so the widget renders deterministically; WidgetCard reads the
// same hook for its identity overrides (none here).
const { widgetConfig, mockUpdateConfig } = vi.hoisted(() => ({
  widgetConfig: {
    current: { range: '1m', accountIds: [] as string[], topLevelOnly: false },
  },
  mockUpdateConfig: vi.fn(),
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({
    config: widgetConfig.current,
    updateConfig: mockUpdateConfig,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ data, onClick }: any) => (
    <div data-testid="pie" style={{ display: 'none' }}>
      {data?.map((d: any, i: number) => (
        <button key={i} data-testid={`pie-slice-${d.name}`} onClick={() => onClick?.(d)} />
      ))}
    </div>
  ),
  Cell: () => null,
  Tooltip: () => null,
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    // 1:1 for every currency except the sentinel ZZZ, which has no rate.
    convertToDefault: (n: number, currency?: string) =>
      currency === 'ZZZ' ? null : n,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6'],
}));

async function renderChart(transactions: any[], categories: any[] = [], isLoading = false) {
  mockGetAllPages.mockResolvedValue(transactions);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <ExpensesPieChart accounts={[]} categories={categories} isLoading={isLoading} />,
    );
  });
  return result!;
}

describe('ExpensesPieChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGetAllPages.mockReset();
    mockUpdateConfig.mockClear();
    widgetConfig.current = { range: '1m', accountIds: [], topLevelOnly: false };
  });

  it('renders loading state with title and pulse animation', async () => {
    await renderChart([], [], true);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders the selected timeframe label', async () => {
    await renderChart([]);
    expect(screen.getByText('1M')).toBeInTheDocument();
  });

  it('renders empty state when no expenses', async () => {
    await renderChart([]);
    await waitFor(() => {
      expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders chart with expense data and category legend', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
      {
        id: '2', amount: -30, categoryId: 'cat2',
        category: { id: 'cat2', name: 'Transport', color: '#3b82f6' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-16',
      },
    ];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
      { id: 'cat2', name: 'Transport', color: '#3b82f6' },
    ];

    await renderChart(transactions, categories);
    await waitFor(() => expect(screen.getByTestId('pie-chart')).toBeInTheDocument());
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
    expect(legendButtons.some((b) => b.textContent?.includes('Transport'))).toBe(true);
  });

  it('shows total expenses amount', async () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  it('marks the total partial and excludes an unconvertible transaction', async () => {
    // Two CAD expenses convert; one ZZZ expense has no rate and must not size a
    // slice. The total is the CAD sum, marked as a subtotal.
    const transactions = [
      {
        id: '1', amount: -100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
      {
        id: '2', amount: -40, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'ZZZ', isTransfer: false, isSplit: false, transactionDate: '2024-01-16',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    // The ZZZ amount is excluded, so the total is the CAD 100 only, marked partial.
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('(partial total)')).toBeInTheDocument();
  });

  it('skips transfer transactions', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: true, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('No expense data for this period.')).toBeInTheDocument());
  });

  // Issue #1125: credits were skipped row by row, so a refund never reached
  // the category it belonged to. They are read and netted now; a category that
  // ends up net-credit is what drops out.
  it('nets a refund against the category it was filed under', async () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Travel', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
      {
        id: '2', amount: 25, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Travel', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-20',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Travel', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.getByText('$75.00')).toBeInTheDocument();
    expect(screen.queryByText('$100.00')).not.toBeInTheDocument();
  });

  it('nets a refund carried on a split line', async () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: true, transactionDate: '2024-01-15',
        splits: [
          { id: 's1', amount: -100, categoryId: 'cat1', category: { id: 'cat1', name: 'Travel' } },
        ],
      },
      {
        id: '2', amount: 40, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: true, transactionDate: '2024-01-20',
        splits: [
          { id: 's2', amount: 40, categoryId: 'cat1', category: { id: 'cat1', name: 'Travel' } },
        ],
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Travel', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.getByText('$60.00')).toBeInTheDocument();
  });

  it('drops a category whose refunds outweigh its spending', async () => {
    const transactions = [
      {
        id: '1', amount: -30, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Travel', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
      {
        id: '2', amount: 50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Travel', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-20',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Travel', color: '#ef4444' }]);
    await waitFor(() =>
      expect(screen.getByText('No expense data for this period.')).toBeInTheDocument(),
    );
  });

  it('skips positive amounts (income)', async () => {
    const transactions = [
      {
        id: '1', amount: 100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Salary', color: '#22c55e' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Salary', color: '#22c55e' }]);
    await waitFor(() => expect(screen.getByText('No expense data for this period.')).toBeInTheDocument());
  });

  it('skips investment account transactions', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        account: { accountType: 'INVESTMENT' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('No expense data for this period.')).toBeInTheDocument());
  });

  it('groups uncategorized expenses', async () => {
    const transactions = [
      {
        id: '1', amount: -75, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions);
    await waitFor(() => {
      const legendButtons = screen.getAllByRole('button');
      expect(legendButtons.some((b) => b.textContent?.includes('Uncategorized'))).toBe(true);
    });
  });

  it('handles split transactions', async () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: true,
        splits: [
          { amount: -60, categoryId: 'cat1', category: { id: 'cat1', name: 'Food', color: '#ef4444' } },
          { amount: -40, categoryId: 'cat2', category: { id: 'cat2', name: 'Drinks', color: '#3b82f6' } },
        ],
        transactionDate: '2024-01-15',
      },
    ];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
      { id: 'cat2', name: 'Drinks', color: '#3b82f6' },
    ];
    await renderChart(transactions, categories);
    await waitFor(() => {
      const legendButtons = screen.getAllByRole('button');
      expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
      expect(legendButtons.some((b) => b.textContent?.includes('Drinks'))).toBe(true);
    });
  });

  it('navigates to category transactions on pie click', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByTestId('pie-slice-Food')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pie-slice-Food'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/transactions?categoryIds=cat1&startDate='));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('endDate='));
  });

  it('aggregates multiple transactions in the same category', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
      {
        id: '2', amount: -25, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-16',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('$75.00')).toBeInTheDocument());
  });

  it('assigns chart colours to categories without a colour', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: null },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: null }]);
    await waitFor(() => expect(screen.getByTestId('pie-chart')).toBeInTheDocument());
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
  });

  it('handles split transaction with uncategorized split (no transferAccountId)', async () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: true,
        splits: [
          { amount: -60, categoryId: 'cat1', category: { id: 'cat1', name: 'Food', color: '#ef4444' } },
          { amount: -40, categoryId: null, category: null, transferAccountId: undefined },
        ],
        transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => {
      const legendButtons = screen.getAllByRole('button');
      expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
      expect(legendButtons.some((b) => b.textContent?.includes('Uncategorized'))).toBe(true);
    });
  });

  // The chart keeps eleven slices; a twelfth category and beyond merge into
  // Other, which the user can open rather than being told nothing about it.
  const overflowTransactions = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `t${i}`,
      // Descending so the ordering is unambiguous: the largest keep their slice.
      amount: -(count - i) * 10,
      currencyCode: 'CAD',
      categoryId: `c${i}`,
      category: { id: `c${i}`, name: `Cat ${i}`, color: '#111111' },
    }));

  it('opens Other into the categories it merged, and closes it again', async () => {
    await renderChart(overflowTransactions(14));

    expect(screen.getByText('Other')).toBeInTheDocument();
    // The tail is not on screen until Other is opened.
    expect(screen.queryByText('Cat 13')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pie-slice-Other'));

    expect(screen.getByText('3 categories in Other')).toBeInTheDocument();
    expect(screen.getByText('Cat 11')).toBeInTheDocument();
    expect(screen.getByText('Cat 12')).toBeInTheDocument();
    expect(screen.getByText('Cat 13')).toBeInTheDocument();
    // The chart itself still shows eleven categories plus Other; opening the
    // tail does not turn it into twenty slivers.
    expect(screen.getByTestId('pie-slice-Cat 0')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    expect(screen.queryByText('Cat 13')).not.toBeInTheDocument();
  });

  it('opens the transactions for a category listed inside Other', async () => {
    await renderChart(overflowTransactions(14));
    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    fireEvent.click(screen.getByText('Cat 12'));

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('categoryIds=c12'),
    );
  });

  it('closes Other when the categories inside it change', async () => {
    const { rerender } = await renderChart(overflowTransactions(14));
    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    expect(screen.getByText('Cat 13')).toBeInTheDocument();

    // A different timeframe asks a different question, so the panel the user
    // opened over the old tail does not stay open over a new one.
    widgetConfig.current = { range: '3m', accountIds: [], topLevelOnly: false };
    mockGetAllPages.mockResolvedValue(overflowTransactions(13));
    await act(async () => {
      rerender(<ExpensesPieChart accounts={[]} categories={[]} isLoading={false} />);
    });
    await waitFor(() => {
      expect(screen.queryByText('Cat 12')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('counts a subcategory against its top-level ancestor when rolled up', async () => {
    widgetConfig.current = { range: '1m', accountIds: [], topLevelOnly: true };
    const categories = [
      { id: 'food', name: 'Food', parentId: null, color: '#111111' },
      { id: 'groceries', name: 'Groceries', parentId: 'food', color: '#222222' },
      { id: 'dining', name: 'Dining', parentId: 'groceries', color: '#333333' },
    ];
    await renderChart(
      [
        { id: 't1', amount: -60, currencyCode: 'CAD', categoryId: 'groceries', category: categories[1] },
        // Two levels down: the walk goes all the way to the root, not one step.
        { id: 't2', amount: -40, currencyCode: 'CAD', categoryId: 'dining', category: categories[2] },
      ],
      categories,
    );

    expect(screen.getByTestId('pie-slice-Food')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-slice-Groceries')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pie-slice-Dining')).not.toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  it('keeps subcategories apart when the rollup is off', async () => {
    const categories = [
      { id: 'food', name: 'Food', parentId: null, color: '#111111' },
      { id: 'groceries', name: 'Groceries', parentId: 'food', color: '#222222' },
    ];
    await renderChart(
      [{ id: 't1', amount: -60, currencyCode: 'CAD', categoryId: 'groceries', category: categories[1] }],
      categories,
    );
    expect(screen.getByTestId('pie-slice-Groceries')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-slice-Food')).not.toBeInTheDocument();
  });
});
