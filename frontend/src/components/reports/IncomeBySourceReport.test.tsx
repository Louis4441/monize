import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/test/render";
import { IncomeBySourceReport } from "./IncomeBySourceReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/hooks/useNumberFormat", () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: "CAD",
  }),
}));

let mockIsValid = true;
vi.mock("@/hooks/useDateRange", () => {
  const resolvedRange = { start: "2024-01-01", end: "2025-01-01" };
  return {
    useDateRange: () => ({
      dateRange: "1y",
      setDateRange: vi.fn(),
      startDate: "",
      setStartDate: vi.fn(),
      endDate: "",
      setEndDate: vi.fn(),
      resolvedRange,
      get isValid() { return mockIsValid; },
    }),
  };
});

vi.mock("@/lib/chart-colours", () => ({
  CHART_COLOURS_INCOME: ["#22c55e", "#3b82f6", "#8b5cf6"],
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-bar" onClick={() => onChange("bar")}>Bar</button>
      <button data-testid="toggle-pie" onClick={() => onChange("pie")}>Pie</button>
    </div>
  ),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
    </div>
  ),
}));

const mockExportToPdf = vi.fn();
vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  PieChart: ({ children }: any) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
  BarChart: ({ children }: any) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
}));

const mockGetIncomeBySource = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getIncomeBySource: (...args: any[]) => mockGetIncomeBySource(...args),
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

describe("IncomeBySourceReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockIsValid = true;
  });

  it("shows loading state initially", () => {
    mockGetIncomeBySource.mockReturnValue(new Promise(() => {}));
    render(<IncomeBySourceReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no data returned", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [],
      totalIncome: 0,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No income data for this period."),
      ).toBeInTheDocument();
    });
  });

  it("renders chart and legend with sample data", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
        {
          categoryId: "cat-2",
          categoryName: "Freelance",
          total: 1000,
          color: "",
        },
      ],
      totalIncome: 6000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    expect(screen.getByText("Freelance")).toBeInTheDocument();
    expect(screen.getByText("Total Income")).toBeInTheDocument();
    expect(screen.getByText("$6000.00")).toBeInTheDocument();
  });

  it("renders controls", async () => {
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chart-view-toggle")).toBeInTheDocument();
  });

  it("renders categories with provided colors", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        {
          categoryId: "cat-1",
          categoryName: "Salary",
          total: 5000,
          color: "#00ff00",
        },
        { categoryId: "", categoryName: "Other", total: 500, color: "" },
      ],
      totalIncome: 5500,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    expect(screen.getByText("Other")).toBeInTheDocument();
    // The Other button should be disabled (no categoryId)
    const otherButton = screen.getByText("Other").closest("button");
    expect(otherButton).toBeDisabled();
  });

  it("shows percentages in legend", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 8000, color: "" },
        {
          categoryId: "cat-2",
          categoryName: "Freelance",
          total: 2000,
          color: "",
        },
      ],
      totalIncome: 10000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("$8000.00 (80.0%)")).toBeInTheDocument();
    });
    expect(screen.getByText("$2000.00 (20.0%)")).toBeInTheDocument();
  });

  it("handles API error gracefully", async () => {
    mockGetIncomeBySource.mockRejectedValue(new Error("Network error"));
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No income data for this period."),
      ).toBeInTheDocument();
    });
  });

  it("navigates to transactions page on category legend click", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
      ],
      totalIncome: 5000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Salary"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryId=cat-1&startDate=2024-01-01&endDate=2025-01-01",
    );
  });

  it("does not navigate when legend button has no categoryId", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "", categoryName: "Unknown", total: 500, color: "" },
      ],
      totalIncome: 500,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Unknown")).toBeInTheDocument();
    });
    // Button is disabled so click should not call router.push
    const btn = screen.getByText("Unknown").closest("button")!;
    fireEvent.click(btn);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("switches to bar chart view when toggle is clicked", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
      ],
      totalIncome: 5000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    // Initially shows pie chart
    expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    // Switch to bar
    fireEvent.click(screen.getByTestId("toggle-bar"));
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("pie-chart")).not.toBeInTheDocument();
  });

  it("switches back to pie chart view from bar view", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
      ],
      totalIncome: 5000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-bar"));
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-pie"));
    await waitFor(() => {
      expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    });
  });

  it("calls exportToPdf with legend items when data is present", async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 8000, color: "#00ff00" },
        { categoryId: "cat-2", categoryName: "Freelance", total: 2000, color: "" },
      ],
      totalIncome: 10000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Income by Source",
          filename: "income-by-source",
          chartLegend: expect.arrayContaining([
            expect.objectContaining({ label: expect.stringContaining("Salary") }),
          ]),
        }),
      );
    });
  });

  it("calls exportToPdf with undefined chartLegend when chart data is empty", async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    // Data becomes empty after load
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No income data for this period."),
      ).toBeInTheDocument();
    });
    // ExportDropdown is still rendered in controls even with empty data
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          chartLegend: undefined,
        }),
      );
    });
  });

  it("shows 0% percentage in legend when totalIncome is zero", async () => {
    // Simulate items but totalIncome = 0 (edge case data mismatch)
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 0, color: "" },
      ],
      totalIncome: 0,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    // When totalIncome is 0, percentage should display as '0'
    expect(screen.getByText("$0.00 (0%)")).toBeInTheDocument();
  });

  it("does not load data when isValid is false", () => {
    mockIsValid = false;
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    render(<IncomeBySourceReport />);
    // loadData is gated on isValid, so the API should not be called
    expect(mockGetIncomeBySource).not.toHaveBeenCalled();
  });
});
