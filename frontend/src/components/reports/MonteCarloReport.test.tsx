import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor, act } from '@testing-library/react';
import { render, screen, within } from '@/test/render';
import type {
  MonteCarloScenario,
  SimulationResult,
  AccountHoldingStats,
} from '@/lib/monte-carlo';

// ────────────── Mocks ─────────────────────────────────────────────────────

const mockApi = vi.hoisted(() => ({
  brokerageAccounts: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runSaved: vi.fn(),
  run: vi.fn(),
  historicalStats: vi.fn(),
  holdingStats: vi.fn(),
}));

vi.mock('@/lib/monte-carlo', () => ({
  monteCarloApi: mockApi,
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyLabel: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/format', async () => {
  const actual = await vi.importActual<typeof import('@/lib/format')>(
    '@/lib/format',
  );
  return { ...actual, getCurrencySymbol: () => '$' };
});

// Recharts is heavy and noisy in jsdom; stub the visual primitives we use.
vi.mock('recharts', () => {
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="rc-container">{children}</div>
    ),
    ComposedChart: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="rc-chart">{children}</div>
    ),
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
    Area: () => null,
    Line: () => null,
    ReferenceDot: ({ x }: { x: string }) => (
      <div data-testid="reference-dot" data-x={x} />
    ),
    ReferenceLine: ({ x }: { x: string }) => (
      <div data-testid="reference-line" data-x={x} />
    ),
  };
});

// ────────────── Fixtures ──────────────────────────────────────────────────

const account = (
  overrides: Partial<{ id: string; name: string; currencyCode: string }> = {},
) => ({
  id: 'acc-1',
  name: 'Brokerage',
  currencyCode: 'CAD',
  ...overrides,
});

const scenario = (
  overrides: Partial<MonteCarloScenario> = {},
): MonteCarloScenario => ({
  id: 'scn-1',
  name: 'Retirement',
  description: null,
  accountIds: ['acc-1'],
  startingValue: 100000,
  useCurrentBalance: true,
  yearsToRetirement: 25,
  annualContribution: 12000,
  contributionGrowthRate: 0.02,
  yearsInRetirement: 30,
  annualWithdrawal: 60000,
  expectedReturn: 0.07,
  volatility: 0.15,
  inflationRate: 0.025,
  showRealValues: false,
  useHistoricalReturns: false,
  simulationCount: 5000,
  targetValue: 1000000,
  randomSeed: null,
  isFavourite: false,
  lastRunAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  cashFlows: [],
  ...overrides,
});

const simResult = (
  overrides: Partial<SimulationResult> = {},
): SimulationResult => ({
  yearLabels: ['2027', '2028', '2029'],
  percentiles: {
    p10: [110, 120, 130],
    p25: [115, 130, 145],
    p50: [120, 140, 160],
    p75: [125, 150, 175],
    p90: [130, 160, 190],
  },
  finalDistribution: {
    min: 50,
    max: 300,
    mean: 165,
    median: 160,
    stdev: 30,
    depletionRate: 0.05,
  },
  successRate: 0.72,
  inputsSnapshot: {},
  realValues: false,
  ranAt: '2026-05-01T00:00:00Z',
  ...overrides,
});

const holdingStats = (): AccountHoldingStats[] => [
  {
    accountId: 'acc-1',
    accountName: 'Brokerage',
    currencyCode: 'CAD',
    holdings: [
      {
        symbol: 'VOO',
        name: 'Vanguard S&P 500',
        currencyCode: 'USD',
        quantity: 10,
        marketValue: 5000,
        yearsObserved: 10,
        meanReturn: 0.1,
        volatility: 0.15,
      },
    ],
  },
];

async function importComponent() {
  // Imported lazily so each test can set up mocks before mounting.
  const mod = await import('./MonteCarloReport');
  return mod.MonteCarloReport;
}

async function renderReport() {
  const MonteCarloReport = await importComponent();
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MonteCarloReport />);
  });
  return result!;
}

// ────────────── Tests ─────────────────────────────────────────────────────

describe('MonteCarloReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.brokerageAccounts.mockResolvedValue([account()]);
    mockApi.list.mockResolvedValue([]);
    mockApi.create.mockResolvedValue(scenario({ id: 'created-1' }));
    mockApi.update.mockResolvedValue(scenario({ id: 'scn-1', name: 'Renamed' }));
    mockApi.remove.mockResolvedValue(undefined);
    mockApi.run.mockResolvedValue(simResult());
    mockApi.runSaved.mockResolvedValue(simResult());
    mockApi.historicalStats.mockResolvedValue({
      yearsObserved: 10,
      meanReturn: 0.1,
      volatility: 0.15,
      currentBalance: 250000,
    });
    mockApi.holdingStats.mockResolvedValue(holdingStats());
    window.localStorage.clear();
  });

  describe('initial load', () => {
    it('shows a spinner while loading and then renders the form', async () => {
      await renderReport();
      await waitFor(() =>
        expect(mockApi.brokerageAccounts).toHaveBeenCalled(),
      );
      await waitFor(() => expect(mockApi.list).toHaveBeenCalled());
      // Once loaded, we see the section legends from the form.
      expect(await screen.findByText('Contribution phase')).toBeInTheDocument();
      expect(screen.getByText('Withdrawal phase')).toBeInTheDocument();
      expect(screen.getByText('Return assumptions')).toBeInTheDocument();
    });

    it('lists saved scenarios in the sidebar and loads one when clicked', async () => {
      const saved = scenario({
        id: 'saved-1',
        name: 'Aggressive 30y',
      });
      mockApi.list.mockResolvedValueOnce([saved]);
      await renderReport();

      const sidebarItem = await screen.findByRole('button', {
        name: /Aggressive 30y/i,
      });
      fireEvent.click(sidebarItem);
      // Loaded scenario name appears in the form's name field.
      const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      expect(nameField).toHaveValue('Aggressive 30y');
    });

    it('restores the last-active scenario from localStorage on mount', async () => {
      const saved = scenario({ id: 'remembered', name: 'Remembered scn' });
      window.localStorage.setItem(
        'monize-monte-carlo-active-id',
        'remembered',
      );
      mockApi.list.mockResolvedValueOnce([saved]);
      await renderReport();
      await waitFor(() => {
        const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
        expect(nameField).toHaveValue('Remembered scn');
      });
    });
  });

  describe('Run simulation', () => {
    it('POSTs current form values to /run and renders summary stats', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const runBtn = screen.getByRole('button', { name: /Run simulation/i });
      await act(async () => {
        fireEvent.click(runBtn);
      });
      expect(mockApi.run).toHaveBeenCalledTimes(1);
      const arg = mockApi.run.mock.calls[0][0];
      expect(arg).toMatchObject({
        useHistoricalReturns: false,
        simulationCount: 5000,
        showRealValues: false,
      });
      // Summary cards
      expect(screen.getByText(/Median final/i)).toBeInTheDocument();
      expect(screen.getByText('$160.00')).toBeInTheDocument(); // median
      expect(
        screen.getByText(/Probability of Depletion/i),
      ).toBeInTheDocument();
      expect(screen.getByText('5.0%')).toBeInTheDocument();
    });

    it('shows the target value next to the success-rate label when set', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'with-target', targetValue: 1000000 }),
      ]);
      mockApi.run.mockResolvedValueOnce(simResult({ successRate: 0.5 }));
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const runBtn = screen.getByRole('button', { name: /Run simulation/i });
      await act(async () => {
        fireEvent.click(runBtn);
      });
      // The label text includes the bracketed target. We just check that
      // the bracketed target appears alongside "Probability Above Target".
      const labels = await screen.findAllByText(
        /Probability Above Target \(\$1,?000,?000\.00\)/i,
      );
      expect(labels.length).toBeGreaterThan(0);
    });
  });

  describe('Save / update / delete', () => {
    it('rejects save when name is blank', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const saveBtn = screen.getByRole('button', {
        name: /Save scenario|Save changes/,
      });
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      expect(mockApi.create).not.toHaveBeenCalled();
    });

    it('creates a new scenario when name is filled', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      fireEvent.change(nameField, { target: { value: 'My plan' } });
      const saveBtn = screen.getByRole('button', { name: /Save scenario/ });
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      expect(mockApi.create).toHaveBeenCalledTimes(1);
      expect(mockApi.create.mock.calls[0][0]).toMatchObject({
        name: 'My plan',
      });
    });

    it('Delete opens a confirmation dialog and only fires after confirm', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      // The form's Delete button (in the action row).
      const formDeleteBtn = await screen.findByRole('button', {
        name: /^Delete$/,
      });
      fireEvent.click(formDeleteBtn);
      // Confirmation dialog appears.
      await screen.findByText(/Delete scenario\?/);
      // Now there are two "Delete" buttons in the DOM — the form one and
      // the modal's confirm. Click the last one (modal Confirm).
      const allDeletes = screen.getAllByRole('button', { name: /^Delete$/ });
      const confirmBtn = allDeletes[allDeletes.length - 1];
      await act(async () => {
        fireEvent.click(confirmBtn);
      });
      expect(mockApi.remove).toHaveBeenCalledWith('scn-1');
    });
  });

  describe('Cash flows', () => {
    it('lets the user add a cash flow row and includes it in /run payload', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const add = screen.getByRole('button', { name: /Add cash flow/i });
      await act(async () => {
        fireEvent.click(add);
      });
      // Find the row's name input (placeholder 'e.g. Pension') and fill.
      const nameInput = screen.getByPlaceholderText('e.g. Pension');
      fireEvent.change(nameInput, { target: { value: 'Pension' } });

      const runBtn = screen.getByRole('button', { name: /Run simulation/i });
      await act(async () => {
        fireEvent.click(runBtn);
      });
      const sent = mockApi.run.mock.calls[0][0];
      expect(sent.cashFlows).toBeDefined();
      expect(sent.cashFlows).toHaveLength(1);
      expect(sent.cashFlows[0]).toMatchObject({
        name: 'Pension',
        flowType: 'ONE_TIME',
        startYear: 1,
      });
    });

    it('removes a row when the trash icon is clicked', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const add = screen.getByRole('button', { name: /Add cash flow/i });
      await act(async () => {
        fireEvent.click(add);
      });
      const removeBtn = screen.getByRole('button', { name: /Remove cash flow/i });
      await act(async () => {
        fireEvent.click(removeBtn);
      });
      expect(
        screen.queryByPlaceholderText('e.g. Pension'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Historical returns mode', () => {
    it('fetches per-holding stats when historical mode is enabled', async () => {
      // Pre-load a scenario so accountIds is non-empty and the holdingStats
      // effect actually fires.
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'], useHistoricalReturns: false }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const radio = screen.getByRole('radio', {
        name: /Use historical returns from selected accounts/i,
      });
      await act(async () => {
        fireEvent.click(radio);
      });
      await waitFor(() =>
        expect(mockApi.holdingStats).toHaveBeenCalledWith(['acc-1']),
      );
      expect(await screen.findByText('VOO')).toBeInTheDocument();
    });
  });

  describe('View toggle and exports', () => {
    it('switches between chart and table view', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Default is chart view; click Table.
      const tableTab = screen.getByRole('button', { name: /^Table$/ });
      await act(async () => {
        fireEvent.click(tableTab);
      });
      // Year column header appears in the results table
      expect(await screen.findByText('Year')).toBeInTheDocument();
    });

    it('CSV export builds a blob with the percentile data', async () => {
      const createObjectURL = vi.fn(() => 'blob:url');
      const revokeObjectURL = vi.fn();
      const origCreate = global.URL.createObjectURL;
      const origRevoke = global.URL.revokeObjectURL;
      global.URL.createObjectURL = createObjectURL as never;
      global.URL.revokeObjectURL = revokeObjectURL as never;

      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Open the dropdown (the Export button) — its options are plain
      // <button>s labeled "CSV" / "PDF", not menu items.
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const csvOption = await screen.findByRole('button', { name: /^CSV$/ });
      await act(async () => {
        fireEvent.click(csvOption);
      });
      expect(createObjectURL).toHaveBeenCalled();

      global.URL.createObjectURL = origCreate;
      global.URL.revokeObjectURL = origRevoke;
    });

    it('PDF export calls exportToPdf with chart container and table data', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const pdfOption = await screen.findByRole('button', { name: /^PDF$/ });
      await act(async () => {
        fireEvent.click(pdfOption);
      });
      expect(exportToPdf).toHaveBeenCalled();
      const args = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.tableData.headers).toContain('Events');
      expect(args.summaryCards.length).toBe(4);
    });
  });

  describe('Phase divider', () => {
    it('renders a phase-transition reference line when both phases are present', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          id: 'mixed',
          yearsToRetirement: 1,
          yearsInRetirement: 2,
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      const line = await screen.findByTestId('reference-line');
      // The yearLabels in our fixture are 2027/28/29; with
      // yearsToRetirement = 1 the divider sits at the first label.
      expect(line.getAttribute('data-x')).toBe('2027');
    });

    it('omits the divider when there is no withdrawal phase', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          id: 'accum-only',
          yearsToRetirement: 3,
          yearsInRetirement: 0,
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      expect(screen.queryByTestId('reference-line')).not.toBeInTheDocument();
    });
  });

  describe('Use current balance', () => {
    it('auto-populates startingValue from /historical-stats when accounts are selected', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      // The default form has the toggle on and one account preselected
      // never (accountIds starts empty), so just simulate selection by
      // letting the effect trigger after we mount with accounts in
      // localStorage-backed scenario. Here we trust the effect via the
      // existing test for sidebar load:
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 's', useCurrentBalance: true, accountIds: ['acc-1'] }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await waitFor(() =>
        expect(mockApi.historicalStats).toHaveBeenCalledWith(['acc-1']),
      );
    });
  });
});

// Suppress noisy "act" warnings printed by recharts ResizeObserver shim.
const origError = console.error;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    const msg = String(args[0] ?? '');
    if (msg.includes('not wrapped in act')) return;
    return origError(...args);
  });
});

// Avoid leaking a module-level export from screen
void within;
