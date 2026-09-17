import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { PortfolioValueReport } from './PortfolioValueReport';
import { renderChartFlagDot } from '@/components/investments/portfolio-chart-utils';
import { chartColors } from '@/lib/chart-colors';
import { usePreferencesStore } from '@/store/preferencesStore';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatCurrencyCompact: (n: number, _currency?: string) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      formatCurrencyFlag: (n: number, _currency?: string) => `$${n}`,
      defaultCurrency: 'CAD',
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

const STABLE_RESOLVED_RANGE = { start: '2024-01-01', end: '2026-01-01' };

let mockDateRangeValue = '2y';
const mockSetDateRange = vi.fn();

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: mockDateRangeValue,
    setDateRange: mockSetDateRange,
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RESOLVED_RANGE,
    isValid: true,
  }),
}));

let mockSeriesMode = 'total';
// Stateful stand-in for the real hook: seed `mockStoredValues` to simulate a
// previous visit, and read it back to assert what the report persisted.
const mockStoredValues = new Map<string, unknown>();
vi.mock('@/hooks/useLocalStorage', async () => {
  const { useState, useCallback } = await vi.importActual<typeof import('react')>('react');
  return {
    useLocalStorage: (key: string, defaultValue: unknown) => {
      const [value, setValue] = useState(() =>
        mockStoredValues.has(key) ? mockStoredValues.get(key) : defaultValue,
      );
      const persist = useCallback(
        (next: unknown) => {
          setValue((prev: unknown) => {
            const resolved =
              typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next;
            mockStoredValues.set(key, resolved);
            return resolved;
          });
        },
        [key],
      );
      if (key === 'monize-reports-portfolio-value-series-mode') {
        return [mockSeriesMode, vi.fn()];
      }
      return [value, persist];
    },
  };
});

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...inputs: any[]) => inputs.filter(Boolean).join(' '),
}));

const mockDateRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: any) => {
    mockDateRangeSelectorProps(props);
    return <div data-testid="date-range-selector" />;
  },
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      {onExportCsv && (
        <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      )}
      <button data-testid="export-pdf" onClick={onExportPdf}>Export PDF</button>
    </div>
  ),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  // `data-points` carries the rows the chart was actually handed, so a test can
  // see what is plotted rather than only what the KPI cards say (#1389).
  AreaChart: ({ children, data }: any) => (
    <div data-testid="area-chart" data-points={JSON.stringify(data ?? [])}>
      {children}
    </div>
  ),
  Legend: () => null,
  // Invoke the dot render-prop so the high/low bubble wiring (and its dismiss
  // control) is exercised. Indices 0..2 cover both extremes of the 3-point
  // series the dismiss test renders.
  Area: ({ dot, connectNulls }: any) =>
    typeof dot === 'function' ? (
      <>
        <span data-testid="area-connect-nulls">{String(connectNulls)}</span>
        {dot({ cx: 10, cy: 20, index: 0 })}
        {dot({ cx: 30, cy: 40, index: 1 })}
        {dot({ cx: 50, cy: 60, index: 2 })}
      </>
    ) : null,
  XAxis: ({ tickFormatter }: any) => (
    <div>
      {tickFormatter ? tickFormatter('Jan 2024') : ''}
      {tickFormatter ? tickFormatter('Jan 1, 2024') : ''}
    </div>
  ),
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (typeof content === 'function') {
      return (
        <div>
          {content({ active: true, payload: [{ value: 100, payload: { name: 'Jan' } }] })}
          {content({ active: false, payload: [] })}
          {content({ active: true, payload: null })}
        </div>
      );
    }
    return null;
  },
}));

vi.mock('@/components/investments/portfolio-chart-utils', async (importActual) => ({
  ...(await importActual<typeof import('@/components/investments/portfolio-chart-utils')>()),
  INTRADAY_RANGES: new Set(['1d', '1w', 'mtd', '1m']),
  buildIntradayCacheKey: vi.fn(() => 'test-cache-key'),
  readIntradayCache: vi.fn(() => null),
  writeIntradayCache: vi.fn(),
  computeTightYAxisDomain: vi.fn((values: number[]) => {
    if (!values.length) return [0, 1];
    return [Math.min(...values), Math.max(...values)];
  }),
  renderChartFlagDot: vi.fn(() => null),
  ChartFlagShadowFilter: () => null,
}));

const mockGetInvestmentsMonthly = vi.fn();
const mockGetInvestmentsDaily = vi.fn();
const mockGetInvestmentsBreakdown = vi.fn();
const mockGetPeriodResult = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetIntradayValue = vi.fn();
const mockGetIntradayBreakdown = vi.fn();
const mockGetSecurities = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsMonthly: (...args: any[]) => mockGetInvestmentsMonthly(...args),
    getInvestmentsDaily: (...args: any[]) => mockGetInvestmentsDaily(...args),
    getInvestmentsBreakdown: (...args: any[]) => mockGetInvestmentsBreakdown(...args),
    getInvestmentsPeriodResult: (...args: any[]) => mockGetPeriodResult(...args),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getIntradayValue: (...args: any[]) => mockGetIntradayValue(...args),
    getIntradayBreakdown: (...args: any[]) => mockGetIntradayBreakdown(...args),
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
  },
}));

// The writer itself is the app's one CSV door and is tested there; what this
// suite asserts is the sections the report hands it.
const mockExportCsvSections = vi.fn();
vi.mock('@/lib/csv-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csv-export')>()),
  exportCsvSections: (...args: unknown[]) => mockExportCsvSections(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const emptyPortfolio = {
  holdings: [],
  holdingsByAccount: [],
  allocation: [],
  totalPortfolioValue: 0,
  totalCostBasis: 0,
  totalGainLoss: 0,
  totalGainLossPercent: 0,
};

/**
 * The server's period result, complete unless a case says otherwise. Every
 * figure the KPI cards print comes from here: the report does no arithmetic
 * over the plotted series any more (#1392).
 */
const periodResult = (overrides: Record<string, unknown> = {}) => ({
  currency: 'CAD',
  startDate: '2024-01-01',
  endDate: '2026-01-01',
  startValue: 50000,
  endValue: 55000,
  valueChange: 5000,
  netExternalFlows: 0,
  knownFlowSubtotal: 0,
  investmentResult: 5000,
  returnPercent: 10,
  returnMethod: 'simple' as const,
  complete: true,
  reasons: [] as string[],
  missingRatePairs: [] as string[],
  unpricedSecurityIds: [] as string[],
  unknownCashAccountIds: [] as string[],
  ...overrides,
});

describe('PortfolioValueReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecurities.mockResolvedValue([]);
    // A null store is the pre-load state, where the hook takes the default.
    usePreferencesStore.setState({ preferences: null });
    mockDateRangeValue = '2y';
    mockSeriesMode = 'total';
    mockStoredValues.clear();
    mockGetPeriodResult.mockResolvedValue(periodResult());
  });

  it('shows loading state initially', () => {
    mockGetInvestmentsMonthly.mockReturnValue(new Promise(() => {}));
    mockGetPeriodResult.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<PortfolioValueReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no monthly data', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data for this period/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with portfolio data', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 52000 },
      { month: '2024-08-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        {
          accountId: 'acc-1',
          accountName: 'TFSA',
          totalMarketValue: 50000,
          cashBalance: 5000,
          totalGainLoss: 3000,
          totalGainLossPercent: 6.0,
        },
      ],
      allocation: [],
      totalPortfolioValue: 55000,
      totalCostBasis: 50000,
      totalGainLoss: 5000,
      totalGainLossPercent: 10.0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Highest Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Lowest Value')).toBeInTheDocument();
    expect(screen.getByText('Value Change')).toBeInTheDocument();
    expect(screen.getByText('Net Deposits and Withdrawals')).toBeInTheDocument();
    expect(screen.getByText('Investment Result')).toBeInTheDocument();
  });

  it('lets the user dismiss a high or low value bubble without persisting it', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 52000 },
      { month: '2024-08-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);

    const flagMock = vi.mocked(renderChartFlagDot);
    await waitFor(() => {
      expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.income)).toBe(true);
    });

    // Both bubbles are wired with a dismiss control and the localized label.
    const highCall = flagMock.mock.calls.find(([o]: any) => o.color === chartColors.income)!;
    expect(typeof highCall[0].onDismiss).toBe('function');
    expect(highCall[0].dismissLabel).toBe('Hide this value');
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.expense)).toBe(true);

    // Dismissing the high bubble hides it on the next render; the low remains.
    flagMock.mockClear();
    await act(async () => {
      highCall[0].onDismiss!();
    });
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.income)).toBe(false);
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.expense)).toBe(true);
  });

  it('renders the area chart', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      totalPortfolioValue: 55000,
      totalGainLoss: 5000,
      totalGainLossPercent: 10,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('renders portfolio breakdown table when account data available', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        {
          accountId: 'acc-1',
          accountName: 'TFSA',
          totalMarketValue: 45000,
          cashBalance: 5000,
          totalGainLoss: 3000,
          totalGainLossPercent: 6.67,
        },
      ],
      allocation: [],
      totalPortfolioValue: 50000,
      totalCostBasis: 47000,
      totalGainLoss: 3000,
      totalGainLossPercent: 6.38,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    // 'TFSA' appears in the breakdown table (the account picker shows the
    // "All Accounts" placeholder until opened).
    expect(screen.getAllByText('TFSA').length).toBeGreaterThanOrEqual(1);
  });

  it('passes date filter ranges including 1w, mtd, 1m, 3m, ytd to DateRangeSelector', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(mockDateRangeSelectorProps).toHaveBeenCalled();
    });
    const lastCall = mockDateRangeSelectorProps.mock.calls[mockDateRangeSelectorProps.mock.calls.length - 1][0];
    // Same list, in the same order, as the Investments page chart offers.
    expect(lastCall.ranges).toEqual(['1d', '1w', 'mtd', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']);
  });

  it('handles loadData error gracefully', async () => {
    mockGetInvestmentsMonthly.mockRejectedValue(new Error('boom'));
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data/)).toBeInTheDocument();
    });
  });

  it('exports pdf with breakdown', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 55000 },
      { month: '2024-08-01', value: 52000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'TFSA', totalMarketValue: 45000, cashBalance: 5000, totalGainLoss: 3000, totalGainLossPercent: 6.67 },
        { accountId: 'acc-2', accountName: 'RRSP', totalMarketValue: 3000, cashBalance: 0, totalGainLoss: -500, totalGainLossPercent: -10 },
      ],
      allocation: [],
      totalPortfolioValue: 53000,
      totalCostBasis: 50000,
      totalGainLoss: 3000,
      totalGainLossPercent: 6,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('exports pdf with no portfolio breakdown rows', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ additionalTables: undefined }),
    );
  });

  it('changes selected account', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio, totalPortfolioValue: 50000,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
  });

  it('persists the account selection so it survives leaving the report', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGetInvestmentsMonthly.mockResolvedValue([{ month: '2024-06-01', value: 50000 }]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => { fireEvent.click(screen.getByText('TFSA')); });
    // The picker debounces before notifying the report.
    await act(async () => { vi.advanceTimersByTime(350); });

    await waitFor(() => {
      expect(mockStoredValues.get('monize-reports-portfolio-value-accounts')).toEqual(['acc-1']);
    });
    vi.useRealTimers();
  });

  it('restores the persisted account selection on mount', async () => {
    mockStoredValues.set('monize-reports-portfolio-value-accounts', ['acc-2']);
    mockGetInvestmentsMonthly.mockResolvedValue([{ month: '2024-06-01', value: 50000 }]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-2', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);

    await waitFor(() => {
      expect(mockGetInvestmentsMonthly).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'acc-2' }),
      );
    });
    expect(mockGetPortfolioSummary).toHaveBeenCalledWith(['acc-2']);
    // The stored selection is left alone when the account still exists.
    expect(mockStoredValues.get('monize-reports-portfolio-value-accounts')).toEqual(['acc-2']);
  });

  it('drops persisted account IDs that no longer exist', async () => {
    mockStoredValues.set('monize-reports-portfolio-value-accounts', ['acc-1', 'gone']);
    mockGetInvestmentsMonthly.mockResolvedValue([{ month: '2024-06-01', value: 50000 }]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);

    await waitFor(() => {
      expect(mockStoredValues.get('monize-reports-portfolio-value-accounts')).toEqual(['acc-1']);
    });
    await waitFor(() => {
      expect(mockGetInvestmentsMonthly).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'acc-1' }),
      );
    });
  });

  it('renders with negative period change', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 60000 },
      { month: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      totalPortfolioValue: 55000,
      totalCostBasis: 60000,
      totalGainLoss: -5000,
      totalGainLossPercent: -8.33,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({
        valueChange: -5000,
        investmentResult: -5000,
        returnPercent: -8.33,
      }),
    );
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Value Change')).toBeInTheDocument();
    });
    // The percentage belongs to the result, never to the value change.
    expect(screen.getByText('-8.3%')).toBeInTheDocument();
  });

  it('handles many monthly data points (>36) for axis ticks', async () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      month: `2020-${String((i % 12) + 1).padStart(2, '0')}-01`,
      value: 50000 + i * 100,
    }));
    mockGetInvestmentsMonthly.mockResolvedValue(data);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
  });

  it('renders account selector dropdown', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
  });

  it('filters INVESTMENT_BROKERAGE accounts from the dropdown', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-cash', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-brok', name: 'TFSA - Brokerage', currencyCode: 'CAD', accountSubType: 'INVESTMENT_BROKERAGE' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
    // Cash account (with suffix stripped) should appear; brokerage account should not
    expect(screen.queryByText('TFSA - Brokerage')).not.toBeInTheDocument();
  });

  it('strips account name suffixes in the dropdown', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    fireEvent.click(trigger);
    // The " - Cash" suffix should be stripped in the option label
    expect(screen.getByText('TFSA')).toBeInTheDocument();
  });

  it('shows breakdown negative gain/loss in red colour class', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'RRSP', totalMarketValue: 40000, cashBalance: 0, totalGainLoss: -5000, totalGainLossPercent: -11.1 },
      ],
      allocation: [],
      totalPortfolioValue: 40000,
      totalCostBasis: 45000,
      totalGainLoss: -5000,
      totalGainLossPercent: -11.1,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    // Negative gain/loss cell should have red text class
    const gainLossCell = screen.getByText('$-5000.00');
    expect(gainLossCell).toHaveClass('text-red-600');
  });

  it('shows breakdown positive gain/loss formatted with + prefix', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'TFSA', totalMarketValue: 48000, cashBalance: 2000, totalGainLoss: 5000, totalGainLossPercent: 11.6 },
      ],
      allocation: [],
      totalPortfolioValue: 50000,
      totalCostBasis: 45000,
      totalGainLoss: 5000,
      totalGainLossPercent: 11.6,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('+$5000.00')).toBeInTheDocument();
    });
  });

  it('shows foreign currency label in summary cards when account currency differs from default', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    // Account with USD currency while default is CAD
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-usd', name: 'USD Account - Cash', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('USD Account'));
    });
    await waitFor(() => {
      // When foreign currency is active, values are formatted with the currency code suffix
      expect(screen.getAllByText('$50000 USD').length).toBeGreaterThan(0);
    });
  });

  /**
   * The period result belongs to the request that produced it (#1392 follow-up).
   * Switching from a populated 3M to a 1D window whose intraday data is
   * unavailable leaves the effect with no first point to measure from, so it
   * never asks -- and the cards must not go on printing the 3M figures under the
   * 1D caption.
   */
  it('drops the previous range figures when the new range never asks', async () => {
    const kpi = (label: string) =>
      screen.getByText(label).parentElement!.parentElement!.textContent;
    mockDateRangeValue = '3m';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-06-02', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    const { rerender } = render(<PortfolioValueReport />);
    await waitFor(() => expect(kpi('Value Change')).toContain('+$5000'));

    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: true,
    });
    await act(async () => {
      rerender(<PortfolioValueReport />);
    });

    await waitFor(() =>
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument(),
    );
    expect(kpi('Value Change')).not.toContain('5000');
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
  });

  it('exports the period summary with raw amounts and their currency', async () => {
    mockDateRangeValue = '3m';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000, complete: true },
      { date: '2024-06-02', value: 51000, complete: true },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-csv'));
    });

    const [, sections] = mockExportCsvSections.mock.calls[0];
    expect(sections[0].headers).toEqual(['Figure', 'Amount', 'Currency']);
    // Raw numbers, so a spreadsheet adds the column up, and the unit beside
    // each one, so a foreign-currency export cannot be read as the reader's.
    expect(sections[0].rows).toEqual([
      ['Highest Value', 51000, 'CAD'],
      ['Lowest Value', 50000, 'CAD'],
      ['Value Change', 5000, 'CAD'],
      ['Net Deposits and Withdrawals', 0, 'CAD'],
      ['Investment Result', 5000, 'CAD'],
      ['Investment Return', 10, '%'],
    ]);
  });

  it('handles daily range (3m) using getInvestmentsDaily', async () => {
    // 3m is in DAILY_RANGES but not in INTRADAY_RANGES, so it uses the daily endpoint
    mockDateRangeValue = '3m';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-06-02', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsDaily).toHaveBeenCalled();
  });

  describe('a day the server could not finish', () => {
    const kpi = (label: string) =>
      screen.getByText(label).parentElement!.textContent;

    it('withholds the high, the low and the change when a day is incomplete', async () => {
      // The cash sleeve of one account has no balance for 06-01, so that point
      // is a subtotal: it cannot be ranked against whole days, and it is one of
      // the two endpoints the period change is measured between (#1389).
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          value: 50000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: false,
          unknownCashAccountIds: ['cash-1'],
        },
        {
          date: '2024-06-02',
          value: 51000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() => expect(kpi('Lowest Value')).toContain('N/A'));
      expect(kpi('Lowest Value')).not.toContain('$50000');
      expect(kpi('Highest Value')).toContain('N/A');
    });

    /**
     * The money figures are the server's, so what withholds them is the
     * server's answer and not the chart's: a period whose boundary day was a
     * subtotal comes back with every figure null and the cause named, and each
     * card draws the unknown marker rather than a number.
     */
    it('draws the unknown marker on each money card the server withheld', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
        { date: '2024-06-02', value: 51000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({
          valueChange: null,
          netExternalFlows: null,
          investmentResult: null,
          returnPercent: null,
          complete: false,
          reasons: ['incompletePrices'],
          unpricedSecurityIds: ['sec-1'],
        }),
      );
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      await waitFor(() =>
        expect(screen.getAllByTestId('unknown-amount')).toHaveLength(3),
      );
      expect(kpi('Value Change')).not.toContain('$');
      expect(kpi('Net Deposits and Withdrawals')).not.toContain('$');
      expect(kpi('Investment Result')).toContain('N/A');
    });

    /**
     * The rule survives to the pixel (`docs/time-series-contract.md` rule 3).
     * The server's `value` on an incomplete day is the subtotal of what it
     * could price and convert, so plotting it draws a measured-looking line --
     * a whole holding period of unpriced securities read as a flat line near
     * zero, which is what was reported against #1389. The point is a gap.
     */
    it('plots no point for a day the server could not finish', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          // The subtotal: the account held a security nothing could price.
          value: 0,
          fxComplete: true,
          pricesComplete: false,
          unpricedSecurityIds: ['sec-a'],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
        {
          date: '2024-06-02',
          value: 51000,
          fxComplete: true,
          pricesComplete: true,
          unpricedSecurityIds: [],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByTestId('area-chart')).toBeInTheDocument();
      });

      await waitFor(() => {
        const plotted = JSON.parse(
          screen.getByTestId('area-chart').getAttribute('data-points')!,
        ) as Array<{ Value: number | null }>;
        expect(plotted.map((p) => p.Value)).toEqual([null, 51000]);
      });
      // ...and the gap is a gap, not a segment drawn across it.
      expect(screen.getByTestId('area-connect-nulls').textContent).toBe('false');
    });

    it('names the security and the dates behind a withheld figure', async () => {
      // "Some days are incomplete" is a dead end; the security, the pair and
      // the account with their dates are the repair (#1389).
      mockDateRangeValue = '3m';
      mockGetSecurities.mockResolvedValue([
        { id: 'sec-a', symbol: 'AGGG', name: 'Global Aggregate Bond' },
      ]);
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          value: 0,
          fxComplete: true,
          missingRatePairs: [],
          pricesComplete: false,
          unpricedSecurityIds: ['sec-a'],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
        {
          date: '2024-06-02',
          value: 0,
          fxComplete: true,
          missingRatePairs: [],
          pricesComplete: false,
          unpricedSecurityIds: ['sec-a'],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);

      await waitFor(() => {
        expect(screen.getByTestId('incomplete-data-details')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId('incomplete-data-details')).toHaveTextContent(
          'AGGG',
        );
      });
      // Both days are one run, and the panel links to where it is repaired.
      expect(screen.getByRole('link', { name: 'AGGG' })).toHaveAttribute(
        'href',
        '/securities/sec-a?tab=prices',
      );
      expect(
        screen.getByTestId('incomplete-data-details').textContent,
      ).not.toContain('sec-a:');
    });

    it('prints the figures when every day is complete', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          value: 50000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          unknownCashAccountIds: [],
        },
        {
          date: '2024-06-02',
          value: 51000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() => expect(kpi('Lowest Value')).toContain('$50000'));
      expect(kpi('Highest Value')).toContain('$51000');
      expect(kpi('Value Change')).not.toContain('N/A');
    });

    it('says nothing about completeness a response never claimed', async () => {
      // An older backend mid-deploy sends no flags at all. Absent is no
      // information, so the figures are printed as before.
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
        { date: '2024-06-02', value: 51000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() => expect(kpi('Lowest Value')).toContain('$50000'));
    });
  });

  it('shows intraday unavailable state for 1d range with fallbackToDaily', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: ['MSFT'],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
    // Should show skipped symbols
    expect(screen.getByText(/MSFT/)).toBeInTheDocument();
  });

  it('shows intraday unavailable with no skipped symbols listed', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
  });

  it('shows intraday fallback warning icon for 1w range with fallbackToDaily', async () => {
    mockDateRangeValue = '1w';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '1d',
      currency: 'CAD',
      range: '1w',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: ['VFV'],
      fallbackToDaily: true,
    });
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('report-intraday-fallback-warning')).toBeInTheDocument();
    });
  });

  it('renders intraday chart points for 1d range without fallback', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [
        { timestamp: '2024-06-01T10:00:00Z', value: 50000 },
        { timestamp: '2024-06-01T11:00:00Z', value: 51000 },
      ],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
  });

  it('dates the closes the cards are measured between on an intraday range', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [
        { timestamp: '2024-06-01T10:00:00Z', value: 50000 },
        { timestamp: '2024-06-01T11:00:00Z', value: 51000 },
      ],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({ startDate: '2026-01-14', endDate: '2026-01-15' }),
    );
    render(<PortfolioValueReport />);

    // The chart draws live prices; these figures are two stored closes, and the
    // reader is told which, rather than left with a card that reads 0.00 beside
    // a line that moved.
    await waitFor(() =>
      expect(
        screen.getByLabelText(/measured between the stored closing values/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByLabelText(/Jan 14, 2026.*Jan 15, 2026/i),
    ).toBeInTheDocument();
  });

  it('names the movement it could not count when the result is withheld', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-01-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({
        investmentResult: null,
        returnPercent: null,
        complete: false,
        reasons: ['externallySettledTrade'],
      }),
    );
    render(<PortfolioValueReport />);

    await waitFor(() =>
      expect(
        screen.getByLabelText(/cannot be counted here/i),
      ).toBeInTheDocument(),
    );
  });

  describe('mtd range', () => {
    /** An intraday response carrying `points`, otherwise unremarkable. */
    const intraday = (points: Array<{ timestamp: string; value: number }>) => ({
      points,
      interval: '15m',
      currency: 'CAD',
      range: '1m',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });

    it('asks the backend for the 1m series, which is what serves mtd', async () => {
      mockDateRangeValue = 'mtd';
      mockGetIntradayValue.mockResolvedValue(
        intraday([{ timestamp: '2024-01-02T14:30:00Z', value: 50000 }]),
      );
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(mockGetIntradayValue).toHaveBeenCalled();
      });
      // 'mtd' is not in the endpoint's enum -- sending it verbatim is a 400.
      expect(mockGetIntradayValue).toHaveBeenCalledWith(
        expect.objectContaining({ range: '1m' }),
      );
    });

    it('trims the rolling month back to the window the chart shows', async () => {
      mockDateRangeValue = 'mtd';
      mockGetIntradayValue.mockResolvedValue(
        intraday([
          // The 1m series reaches into the previous month; mtd starts at
          // STABLE_RESOLVED_RANGE.start (2024-01-01).
          { timestamp: '2023-12-28T14:30:00Z', value: 40000 },
          { timestamp: '2024-01-02T14:30:00Z', value: 50000 },
          { timestamp: '2024-01-10T14:30:00Z', value: 52000 },
        ]),
      );
      // The prior close is Dec 31's -- the day before the first point shown.
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2023-12-31', value: 49000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Highest Value')).toBeInTheDocument();
      });

      // 40000 came from December and is not part of the month to date, so it
      // must not become the chart's low.
      await waitFor(() =>
        expect(
          screen.getByText('Lowest Value').parentElement!.textContent,
        ).toContain('$50000'),
      );
      expect(
        screen.getByText('Lowest Value').parentElement!.textContent,
      ).not.toContain('$40000');
    });

    it('asks for the period result against the close before the month started', async () => {
      mockDateRangeValue = 'mtd';
      mockGetIntradayValue.mockResolvedValue(
        intraday([
          { timestamp: '2024-01-02T14:30:00Z', value: 50000 },
          { timestamp: '2024-01-10T14:30:00Z', value: 52000 },
        ]),
      );
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({ valueChange: 3000, investmentResult: 3000 }),
      );
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      // The baseline is the day before the first point ON SCREEN, and the
      // server measures from it: the client picks the date and nothing else.
      await waitFor(() =>
        expect(mockGetPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ baselineDate: '2024-01-01' }),
        ),
      );
      await waitFor(() =>
        expect(
          screen.getByText('Value Change').parentElement!.textContent,
        ).toContain('+$3000'),
      );
      // Not the change between the two points plotted, which is what the
      // client used to work out for itself.
      expect(
        screen.getByText('Value Change').parentElement!.textContent,
      ).not.toContain('+$2000');
    });

    it('asks the per-security breakdown for the 1m series too', async () => {
      mockDateRangeValue = 'mtd';
      mockSeriesMode = 'securities';
      mockGetIntradayBreakdown.mockResolvedValue({
        series: [{ key: 'sec-1', type: 'security', symbol: 'VFV', name: 'VFV' }],
        points: [
          { timestamp: '2023-12-28T14:30:00Z', total: 40000, values: { 'sec-1': 40000 } },
          { timestamp: '2024-01-02T14:30:00Z', total: 50000, values: { 'sec-1': 50000 } },
        ],
        interval: '15m',
        currency: 'CAD',
        range: '1m',
        fetchedAt: new Date().toISOString(),
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(mockGetIntradayBreakdown).toHaveBeenCalled();
      });
      expect(mockGetIntradayBreakdown).toHaveBeenCalledWith(
        expect.objectContaining({ range: '1m' }),
      );
      // The December bar is trimmed here as well, so the stacked view and the
      // total view cover the same days.
      await waitFor(() =>
        expect(
          screen.getByText('Highest Value').parentElement!.textContent,
        ).toContain('$50000'),
      );
    });
  });

  describe('prior-close baseline', () => {
    /** Text of the summary card carrying `label`. */
    const card = (label: string) => screen.getByText(label).parentElement!.textContent;

    const intradayWeek = () => ({
      points: [
        { timestamp: '2024-06-03T13:30:00Z', value: 50000 },
        { timestamp: '2024-06-07T20:00:00Z', value: 51000 },
      ],
      interval: '15m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });

    it('sends the close before the week shown as the baseline', async () => {
      mockDateRangeValue = '1w';
      mockGetIntradayValue.mockResolvedValue(intradayWeek());
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({
          startDate: '2024-06-02',
          valueChange: 2000,
          investmentResult: 2000,
          returnPercent: 4.08,
        }),
      );
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      await waitFor(() =>
        expect(mockGetPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ baselineDate: '2024-06-02' }),
        ),
      );
      await waitFor(() => expect(card('Value Change')).toContain('+$2000'));
      // Not the move between the two points plotted, which is the figure the
      // report used to derive for itself.
      expect(card('Value Change')).not.toContain('+$1000');
      expect(card('Investment Result')).toContain('+4.1%');
    });

    it('reports every figure as unknown when the server cannot answer', async () => {
      mockDateRangeValue = '1w';
      mockGetIntradayValue.mockResolvedValue(intradayWeek());
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockRejectedValue(new Error('period result unavailable'));
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      // A failed request is not a change of zero, and not the first point's
      // change wearing the prior close's label.
      await waitFor(() => expect(card('Investment Result')).toContain('N/A'));
      expect(card('Value Change')).not.toContain('$1000');
      expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
    });

    it('sends no baseline on a long range, which measures from its first point', async () => {
      mockGetInvestmentsMonthly.mockResolvedValue([
        { month: '2024-06-01', value: 50000 },
        { month: '2024-07-01', value: 55000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      await waitFor(() => expect(card('Value Change')).toContain('+$5000'));
      expect(mockGetPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ baselineDate: undefined }),
      );
    });
  });

  it('handles intraday fetch error gracefully', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockRejectedValue(new Error('network error'));
    // Component falls back to daily on intraday error; mock it empty so chart stays empty
    mockGetInvestmentsDaily.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data|Intraday view unavailable/i)).toBeInTheDocument();
    });
  });

  it('shows background loading indicator when data is being refreshed', async () => {
    // First load resolves; second (triggered by account change) stays pending
    mockGetInvestmentsMonthly
      .mockResolvedValueOnce([{ month: '2024-06-01', value: 50000 }])
      .mockReturnValueOnce(new Promise(() => {}));
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    // Trigger a reload by changing the account — new fetch hangs, but old points are shown
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('report-chart-loading-indicator')).toBeInTheDocument();
    });
  });

  it('renders many daily data points (>36) axis tick logic', async () => {
    mockDateRangeValue = '3m';
    const data = Array.from({ length: 50 }, (_, i) => ({
      date: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      value: 50000 + i * 100,
    }));
    mockGetInvestmentsDaily.mockResolvedValue(data);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsDaily).toHaveBeenCalled();
  });

  it('prints the zero return the server sent over a single chart point', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({ valueChange: 0, investmentResult: 0, returnPercent: 0 }),
    );
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('+0.0%')).toBeInTheDocument();
    });
  });

  it('exports pdf using foreign-currency fmtFull when account has foreign currency', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 40000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-usd', accountName: 'USD Account', totalMarketValue: 40000, cashBalance: 0, totalGainLoss: 1000, totalGainLossPercent: 2.5 },
      ],
      allocation: [],
      totalPortfolioValue: 40000,
      totalCostBasis: 39000,
      totalGainLoss: 1000,
      totalGainLossPercent: 2.5,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-usd', name: 'USD Account - Brokerage', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    // Select the USD account first to activate foreign currency path
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    // The account name also appears in the breakdown table, so target the
    // option's checkbox inside the dropdown rather than matching by text.
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox'));
    });
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('switches to table view, exercises sort, and exports CSV', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-01-01', value: 50000 },
      { month: '2024-02-01', value: 52000 },
      { month: '2024-03-01', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      holdingsByAccount: [
        {
          accountId: 'a1',
          accountName: 'Account A',
          totalMarketValue: 25000,
          cashBalance: 1000,
          totalGainLoss: 500,
        },
        {
          accountId: 'a2',
          accountName: 'Account B',
          totalMarketValue: 25000,
          cashBalance: 500,
          totalGainLoss: -200,
        },
      ],
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    const { container } = render(<PortfolioValueReport />);
    // Wait for the chart to render so the toggle is mounted.
    await waitFor(() => expect(screen.getByTitle('Table')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTitle('Table')); });
    // The chart card now renders a table; click each header to exercise sort.
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const tables = container.querySelectorAll('table');
    expect(tables.length).toBeGreaterThan(0);
    // Exercise sort headers on every rendered table (chart-table + breakdown table).
    const tableCount = tables.length;
    for (let t = 0; t < tableCount; t += 1) {
      const headerCount = container.querySelectorAll('table')[t].querySelectorAll('th').length;
      for (let __i = 0; __i < headerCount; __i += 1) {
        const __ths = container.querySelectorAll('table')[t].querySelectorAll('th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
      for (let __i = 0; __i < headerCount; __i += 1) {
        const __ths = container.querySelectorAll('table')[t].querySelectorAll('th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
    }
    // Trigger CSV export.
    await act(async () => { fireEvent.click(screen.getByTestId('export-csv')); });
  });

  const breakdownFixture = {
    granularity: 'monthly' as const,
    currency: 'CAD',
    series: [
      { key: 'sec-1', type: 'security' as const, symbol: 'AAPL', name: 'Apple Inc.' },
      { key: 'other', type: 'other' as const, symbol: null, name: '' },
      { key: 'cash', type: 'cash' as const, symbol: null, name: '' },
    ],
    points: [
      { date: '2024-06-01', total: 1500, values: { 'sec-1': 800, other: 200, cash: 500 } },
      { date: '2024-07-01', total: 1700, values: { 'sec-1': 900, other: 300, cash: 500 } },
    ],
  };

  it('loads the per-security breakdown and renders the stacked chart when By security is active', async () => {
    mockSeriesMode = 'securities';
    mockGetInvestmentsBreakdown.mockResolvedValue(breakdownFixture);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'monthly' }),
    );
    // The total-only endpoints are not used while By security is active.
    expect(mockGetInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('uses daily granularity for the breakdown on shorter ranges', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '3m';
    mockGetInvestmentsBreakdown.mockResolvedValue({ ...breakdownFixture, granularity: 'daily' });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(mockGetInvestmentsBreakdown).toHaveBeenCalledWith(
        expect.objectContaining({ granularity: 'daily' }),
      );
    });
  });

  it('renders the per-security table with a column per band and exports CSV', async () => {
    mockSeriesMode = 'securities';
    mockGetInvestmentsBreakdown.mockResolvedValue(breakdownFixture);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => expect(screen.getByTitle('Table')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTitle('Table')); });
    // Security band (symbol), rolled-up "Other securities" and "Cash" bands
    // each get a column header.
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    expect(screen.getByText('Other securities')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    // A per-band cell value is formatted with the currency formatter.
    expect(screen.getAllByText('$800.00').length).toBeGreaterThanOrEqual(1);
    await act(async () => { fireEvent.click(screen.getByTestId('export-csv')); });
  });

  const intradayBreakdownFixture = {
    series: [
      { key: 'sec-1', type: 'security' as const, symbol: 'AAPL', name: 'Apple Inc.' },
      { key: 'cash', type: 'cash' as const, symbol: null, name: '' },
    ],
    points: [
      { timestamp: '2024-06-01T13:30:00.000Z', total: 1500, values: { 'sec-1': 1000, cash: 500 } },
      { timestamp: '2024-06-01T13:31:00.000Z', total: 1600, values: { 'sec-1': 1100, cash: 500 } },
    ],
    interval: '1m' as const,
    currency: 'CAD',
    range: '1d' as const,
    fetchedAt: new Date().toISOString(),
    skippedSymbols: [],
    failedSymbols: [],
    fallbackToDaily: false,
  };

  it('renders the intraday per-security breakdown for the 1d range', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '1d';
    mockGetIntradayBreakdown.mockResolvedValue(intradayBreakdownFixture);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
    expect(mockGetIntradayBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ range: '1d' }),
    );
    // The daily/monthly breakdown endpoint is not used for an intraday range.
    expect(mockGetInvestmentsBreakdown).not.toHaveBeenCalled();
    // The By security toggle is now available on every range, including 1d.
    expect(screen.getByRole('button', { name: 'By security' })).not.toBeDisabled();
  });

  it('shows the intraday-unavailable note when the 1d breakdown falls back', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '1d';
    mockGetIntradayBreakdown.mockResolvedValue({
      ...intradayBreakdownFixture,
      series: [],
      points: [],
      skippedSymbols: ['MSFT'],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/MSFT/)).toBeInTheDocument();
  });

  it('falls back to the daily breakdown with a warning for the 1w range', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '1w';
    mockGetIntradayBreakdown.mockResolvedValue({
      ...intradayBreakdownFixture,
      series: [],
      points: [],
      range: '1w',
      interval: '5m',
      skippedSymbols: ['VFV'],
      fallbackToDaily: true,
    });
    mockGetInvestmentsBreakdown.mockResolvedValue({ ...breakdownFixture, granularity: 'daily' });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('report-intraday-fallback-warning')).toBeInTheDocument();
    });
    // 1W fell back to the daily-snapshot breakdown.
    expect(mockGetInvestmentsBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'daily' }),
    );
  });
});
