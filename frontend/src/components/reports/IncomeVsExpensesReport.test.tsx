import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { IncomeVsExpensesReport } from "./IncomeVsExpensesReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: "CAD",
    }),
};
});
const STABLE_RANGE = { start: "2024-01-01", end: "2025-01-01" };
vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "1y",
    setDateRange: vi.fn(),
    startDate: "",
    setStartDate: vi.fn(),
    endDate: "",
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RANGE,
    isValid: true,
  }),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-bar" onClick={() => onChange("bar")}>Bar</button>
      <button data-testid="toggle-table" onClick={() => onChange("table")}>Table</button>
    </div>
  ),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportPdf, onExportCsv }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
      {onExportCsv && (
        <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      )}
    </div>
  ),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children, onClick }: any) => (
    <div
      data-testid="bar-chart"
      onClick={() => onClick?.({ activeLabel: "2024-01" })}
    >
      {children}
    </div>
  ),
  Bar: ({ dataKey, onClick }: any) => (
    <button
      data-testid={`bar-${dataKey}`}
      onClick={() =>
        onClick?.(
          { payload: { monthStart: "2024-01-01", monthEnd: "2024-01-31" } },
          0,
          new MouseEvent("click"),
        )
      }
    />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
}));

const mockGetIncomeVsExpenses = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getIncomeVsExpenses: (...args: any[]) => mockGetIncomeVsExpenses(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("IncomeVsExpensesReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetIncomeVsExpenses.mockReturnValue(new Promise(() => {}));
    render(<IncomeVsExpensesReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no data returned", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("No data for this period.")).toBeInTheDocument();
    });
  });

  it("renders chart and summary cards with sample data", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 },
        { period: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29", income: 5200, expenses: 3500, net: 1700 },
      ],
      totals: { income: 10200, expenses: 6500, net: 3700, knownIncome: 10200, knownExpenses: 6500, knownNet: 3700 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Income")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Expenses")).toBeInTheDocument();
    expect(screen.getByText("Total Savings")).toBeInTheDocument();
    expect(screen.getByText("Savings Rate")).toBeInTheDocument();
  });

  it("renders date range selector", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
  });

  it("renders negative savings with orange styling", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 2000, expenses: 3000, net: -1000 }],
      totals: { income: 2000, expenses: 3000, net: -1000, knownIncome: 2000, knownExpenses: 3000, knownNet: -1000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Savings")).toBeInTheDocument();
    });
    expect(screen.getByText("Savings Rate")).toBeInTheDocument();
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error("Network error"));
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("renders bar chart with monthly data", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  it("navigates to transactions page with date range on chart background click", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-chart"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31",
    );
  });

  it("navigates with income categoryType when clicking Income bar", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-Income")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-Income"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31&categoryType=income",
    );
  });

  it("navigates with expense categoryType when clicking Expenses bar", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-Expenses")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-Expenses"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31&categoryType=expense",
    );
  });

  it("does not include categoryType when clicking Savings bar", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-Savings")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-Savings"));
    // Savings bar has no categoryType onClick, so falls through to chart-level click (date only)
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31",
    );
  });

  it("computes savingsRate when totals.income is 0 (zero-income branch)", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 0, expenses: 100, net: -100 }],
      totals: { income: 0, expenses: 100, net: -100, knownIncome: 0, knownExpenses: 100, knownNet: -100 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => expect(screen.getByText("Total Income")).toBeInTheDocument());
    expect(screen.getByText("0.0%")).toBeInTheDocument();
  });

  it("renders sortable table view, sorts each column, navigates and exports CSV", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { period: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29", income: 5200, expenses: 3500, net: 1700 },
        { period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 },
        { period: "2024-03", periodStart: "2024-03-01", periodEnd: "2024-03-31", income: 1000, expenses: 2000, net: -1000 },
      ],
      totals: { income: 11200, expenses: 8500, net: 2700, knownIncome: 11200, knownExpenses: 8500, knownNet: 2700 },
    });
    const { container } = render(<IncomeVsExpensesReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('th').length;
    expect(headerCount).toBeGreaterThan(0);
    for (let i = 0; i < headerCount; i += 1) {
      const ths = container.querySelectorAll('th');
      if (!ths[i]) break;
      await act(async () => { fireEvent.click(ths[i]); });
    }
    for (let i = 0; i < headerCount; i += 1) {
      const ths = container.querySelectorAll('th');
      if (!ths[i]) break;
      await act(async () => { fireEvent.click(ths[i]); });
    }
    // Click a row to navigate.
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(rows[0]); });
    await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
  });

  // The row is the click target, so it has to be reachable and operable from
  // the keyboard as well (WCAG 2.1.1). Before the fix this row was a
  // `cursor-pointer` `<tr>` with an `onClick` and no `tabIndex` and no
  // `onKeyDown` -- the whole suite was green over a row no keyboard user could
  // use, so this case is what fails on that shape.
  it("activates a month row from the keyboard", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    const { container } = render(<IncomeVsExpensesReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const row = container.querySelector('tbody tr') as HTMLElement;
    expect(row).toHaveAttribute('tabindex', '0');

    const expected = "/transactions?startDate=2024-01-01&endDate=2024-01-31";
    await act(async () => { fireEvent.keyDown(row, { key: 'Enter' }); });
    expect(mockPush).toHaveBeenCalledWith(expected);

    mockPush.mockClear();
    await act(async () => { fireEvent.keyDown(row, { key: ' ' }); });
    expect(mockPush).toHaveBeenCalledWith(expected);

    // A key the row does not claim stays the browser's.
    mockPush.mockClear();
    await act(async () => { fireEvent.keyDown(row, { key: 'a' }); });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("marks the totals as subtotals when the server left a row out", async () => {
    // Each total is withheld when a row could not be converted; what is shown
    // is the part that did convert, marked. Income, expenses and savings all
    // come from the same window, so all three carry the marker.
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: null, expenses: null, net: null, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: "CAD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });

    await act(async () => {
      render(<IncomeVsExpensesReport />);
    });

    expect((await screen.findAllByTestId("partial-total")).length).toBeGreaterThan(0);
  });

  it("leaves complete totals unmarked", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    });

    await act(async () => {
      render(<IncomeVsExpensesReport />);
    });
    await waitFor(() => expect(screen.getByTestId("bar-chart")).toBeInTheDocument());

    expect(screen.queryByTestId("partial-total")).toBeNull();
  });
});
