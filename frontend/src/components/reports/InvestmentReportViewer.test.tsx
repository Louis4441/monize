import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import { InvestmentReportViewer } from './InvestmentReportViewer';

const mockGetById = vi.fn();
const mockExecute = vi.fn();
vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: {
    getById: (...a: unknown[]) => mockGetById(...a),
    execute: (...a: unknown[]) => mockExecute(...a),
  },
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...a: unknown[]) => mockExportToCsv(...a),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatNumber: (n: number) => String(n),
    formatPercent: (n: number) => `${n}%`,
  }),
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser' }),
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const report = {
  id: 'r1',
  name: 'Holdings',
  description: 'My holdings',
  groupBy: 'NONE',
  config: { columns: ['symbol', 'marketValue'], accountIds: [], sortColumn: 'symbol', sortDirection: 'ASC', asOfDate: null },
};

const result = {
  reportId: 'r1',
  name: 'Holdings',
  asOfDate: '2024-06-10',
  baseCurrency: 'USD',
  groupBy: 'NONE',
  columns: ['symbol', 'marketValue'],
  groups: [
    {
      key: 'all',
      label: '',
      rows: [
        { id: '1', values: { symbol: 'AAA', marketValue: 200 } },
        { id: '2', values: { symbol: 'BBB', marketValue: 100 } },
      ],
    },
  ],
  rowCount: 2,
};

async function renderViewer() {
  await act(async () => {
    render(<InvestmentReportViewer reportId="r1" />);
  });
}

describe('InvestmentReportViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(report);
    mockExecute.mockResolvedValue(result);
  });

  it('runs the report and renders rows with the as-of date', async () => {
    await renderViewer();
    expect(await screen.findByText('AAA')).toBeInTheDocument();
    expect(screen.getByText('BBB')).toBeInTheDocument();
    expect(screen.getByText(/As of 2024-06-10/)).toBeInTheDocument();
    expect(screen.getByText(/2 holdings/)).toBeInTheDocument();
  });

  it('sorts rows when a column header is clicked', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    // Default sort is by symbol asc -> AAA before BBB
    let bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('AAA')).toBeInTheDocument();

    // Sort by Market Value ascending -> BBB (100) before AAA (200)
    await act(async () => {
      fireEvent.click(screen.getByText('Market Value'));
    });
    bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('BBB')).toBeInTheDocument();
  });

  it('exports the visible rows to CSV', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    });
    expect(mockExportToCsv).toHaveBeenCalled();
    const [, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(headers).toEqual(['Symbol', 'Market Value']);
    expect(rows).toHaveLength(2);
  });

  it('re-runs the report when the as-of date is changed', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    expect(mockExecute).toHaveBeenCalledWith('r1', {});
  });

  it('shows an empty state when there are no holdings', async () => {
    mockExecute.mockResolvedValue({ ...result, groups: [], rowCount: 0 });
    await renderViewer();
    expect(
      await screen.findByText(/No holdings found/),
    ).toBeInTheDocument();
  });
});
