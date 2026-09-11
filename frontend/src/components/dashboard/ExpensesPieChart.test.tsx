import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@/test/render';
import { ExpensesPieChart } from './ExpensesPieChart';
import type { SpendingByCategoryResponse } from '@/types/built-in-reports';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// The breakdown is the Spending by Category report's answer. What counts as
// spending -- VOID rows, transfers, investment linkage, refunds netted against
// their category -- is the report's to decide and is tested against the query
// in `spending-reports.service.spec.ts`; this suite covers what the widget does
// with the answer.
const mockGetSpendingByCategory = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getSpendingByCategory: (...args: any[]) => mockGetSpendingByCategory(...args),
  },
}));

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

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6'],
}));

const category = (
  categoryId: string | null,
  categoryName: string,
  total: number,
  color: string | null = null,
) => ({ categoryId, categoryName, color, total });

/** A complete report answer: nothing excluded, so the total is a total. */
const report = (
  data: SpendingByCategoryResponse['data'],
  over: Partial<SpendingByCategoryResponse> = {},
): SpendingByCategoryResponse => {
  const knownSpending = data.reduce((sum, item) => sum + item.total, 0);
  return {
    data,
    totalSpending: knownSpending,
    knownSpending,
    currency: 'CAD',
    missingCurrencies: [],
    excludedCount: 0,
    ...over,
  };
};

async function renderChart(
  response: SpendingByCategoryResponse | null,
  isLoading = false,
) {
  if (response) mockGetSpendingByCategory.mockResolvedValue(response);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<ExpensesPieChart accounts={[]} isLoading={isLoading} />);
  });
  return result!;
}

describe('ExpensesPieChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGetSpendingByCategory.mockReset();
    mockUpdateConfig.mockClear();
    widgetConfig.current = { range: '1m', accountIds: [], topLevelOnly: false };
  });

  it('renders loading state with title and pulse animation', async () => {
    await renderChart(report([]), true);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders the selected timeframe label', async () => {
    await renderChart(report([]));
    expect(screen.getByText('1M')).toBeInTheDocument();
  });

  it('renders empty state when the report finds no spending', async () => {
    await renderChart(report([]));
    await waitFor(() => {
      expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('draws the report rows as slices, in the order it returned them', async () => {
    await renderChart(
      report([
        category('cat1', 'Food', 50, '#ef4444'),
        category('cat2', 'Transport', 30, '#3b82f6'),
      ]),
    );

    expect(screen.getByTestId('pie-slice-Food')).toBeInTheDocument();
    expect(screen.getByTestId('pie-slice-Transport')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Transport')).toBeInTheDocument();
  });

  it('shows the report total, not a sum it worked out itself', async () => {
    await renderChart(
      report([category('cat1', 'Food', 50), category('cat2', 'Transport', 30)]),
    );
    expect(screen.getByText('$80.00')).toBeInTheDocument();
  });

  it('gives a category with no colour one from the palette', async () => {
    await renderChart(report([category('cat1', 'Food', 50)]));
    // Rendered at all, rather than as an uncoloured slice.
    expect(screen.getByTestId('pie-slice-Food')).toBeInTheDocument();
  });

  it('names the uncategorized bucket the report returned', async () => {
    await renderChart(report([category(null, 'Uncategorized', 40)]));
    expect(screen.getByTestId('pie-slice-Uncategorized')).toBeInTheDocument();
  });

  // --- what the widget asks the report for -------------------------------

  it('asks for the configured window, accounts and rollup', async () => {
    widgetConfig.current = {
      range: '1m',
      accountIds: ['acct-1', 'acct-2'],
      topLevelOnly: true,
    };
    await renderChart(report([]));

    expect(mockGetSpendingByCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: ['acct-1', 'acct-2'],
        rollupToParent: true,
      }),
    );
  });

  it('asks for leaf categories when the rollup is off', async () => {
    await renderChart(report([]));
    expect(mockGetSpendingByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ rollupToParent: false }),
    );
  });

  it('sends no account filter for an empty selection', async () => {
    await renderChart(report([]));
    expect(mockGetSpendingByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: undefined }),
    );
  });

  // --- partial totals ----------------------------------------------------

  it('marks the total a subtotal when the report excluded a row', async () => {
    await renderChart(
      report([category('cat1', 'Food', 50)], {
        totalSpending: null,
        knownSpending: 50,
        missingCurrencies: ['JPY'],
        excludedCount: 1,
      }),
    );

    // The figure shown is the part that converted, marked rather than presented
    // as the whole.
    expect(screen.getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByTestId('partial-total')).toBeInTheDocument();
  });

  it('leaves a complete total unmarked', async () => {
    await renderChart(report([category('cat1', 'Food', 50)]));
    expect(screen.queryByTestId('partial-total')).toBeNull();
  });

  // --- Other, and its disclosure -----------------------------------------

  const overflowReport = (count: number) =>
    report(
      Array.from({ length: count }, (_, i) =>
        // Descending so the ordering is unambiguous: the largest keep a slice.
        category(`c${i}`, `Cat ${i}`, (count - i) * 10),
      ),
    );

  it('opens Other into the categories it merged, and closes it again', async () => {
    await renderChart(overflowReport(14));

    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.queryByText('Cat 13')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pie-slice-Other'));

    expect(screen.getByText('3 categories in Other')).toBeInTheDocument();
    expect(screen.getByText('Cat 11')).toBeInTheDocument();
    expect(screen.getByText('Cat 12')).toBeInTheDocument();
    expect(screen.getByText('Cat 13')).toBeInTheDocument();
    // The chart still shows eleven categories plus Other; opening the tail does
    // not turn it into twenty slivers.
    expect(screen.getByTestId('pie-slice-Cat 0')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    expect(screen.queryByText('Cat 13')).not.toBeInTheDocument();
  });

  it('keeps the total over every category, including the ones inside Other', async () => {
    // 14 categories at 140 down to 10: the donut's total is all of them, which
    // is also what the slices plus Other add up to.
    await renderChart(overflowReport(14));
    expect(screen.getByText('$1050.00')).toBeInTheDocument();
  });

  it('opens the transactions for a category listed inside Other', async () => {
    await renderChart(overflowReport(14));
    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    fireEvent.click(screen.getByText('Cat 12'));

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('categoryIds=c12'),
    );
  });

  it('closes Other when the categories inside it change', async () => {
    const { rerender } = await renderChart(overflowReport(14));
    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    expect(screen.getByText('Cat 13')).toBeInTheDocument();

    widgetConfig.current = { range: '3m', accountIds: [], topLevelOnly: false };
    mockGetSpendingByCategory.mockResolvedValue(overflowReport(13));
    await act(async () => {
      rerender(<ExpensesPieChart accounts={[]} isLoading={false} />);
    });
    await waitFor(() => {
      expect(screen.queryByText('Cat 12')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  // --- drill-down --------------------------------------------------------

  it('opens the transactions for a clicked slice, scoped to the window', async () => {
    await renderChart(report([category('cat1', 'Food', 50)]));
    fireEvent.click(screen.getByTestId('pie-slice-Food'));

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('categoryIds=cat1'),
    );
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('endDate='));
  });

  it('does nothing for a slice with no category to open', async () => {
    await renderChart(report([category(null, 'Uncategorized', 40)]));
    fireEvent.click(screen.getByTestId('pie-slice-Uncategorized'));
    expect(mockPush).not.toHaveBeenCalled();
  });
});
