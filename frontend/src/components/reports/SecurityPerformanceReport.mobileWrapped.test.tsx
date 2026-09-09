import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SecurityPerformanceReport } from './SecurityPerformanceReport';

/**
 * The phone layout of the Security Performance report's two history tables
 * (Transaction History and Dividend History).
 *
 * Both are ONE tree restyled by CSS (mechanism A): below `sm` each row wraps
 * into a grid card and the column header row is replaced by a sort strip, from
 * `sm` up each is the ordinary table. jsdom applies no media queries, so both
 * header rows and every phone caption are in the DOM here at all times -- which
 * is what lets these assertions read the phone markup without emulating a
 * viewport, and why the sort controls are addressed by position (each label
 * matches the phone strip, the column header row, and a caption).
 */

const mockGetSecurities = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetSecurityPrices = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetMarketIndexes = vi.fn();
const mockGetPerformanceComparison = vi.fn();

// A router of this file's own, so "clicking a row navigates nowhere" is an
// assertion about behaviour rather than about a class. Built inside the factory
// because `vi.mock` is hoisted above the const it would close over, and returned
// as one stable object, as the shared setup's router is.
const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => '/reports/security-performance',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportPdf }: any) => (
    <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
  ),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
  }),
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...inputs: any[]) => inputs.flat(Infinity).filter(Boolean).join(' '),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  Legend: () => null,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceLine: () => null,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getSecurityPrices: (...args: any[]) => mockGetSecurityPrices(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getMarketIndexes: (...args: any[]) => mockGetMarketIndexes(...args),
    getPerformanceComparison: (...args: any[]) => mockGetPerformanceComparison(...args),
  },
}));

const mockSecurities = [
  { id: 's-1', symbol: 'AAPL', name: 'Apple Inc.', isActive: true, currencyCode: 'USD', exchange: 'NASDAQ', securityType: 'STOCK' },
];

const mockHoldings = [
  {
    id: 'h-1', accountId: 'acc-1', securityId: 's-1', symbol: 'AAPL', name: 'Apple Inc.',
    securityType: 'STOCK', currencyCode: 'USD', quantity: 10, averageCost: 150, costBasis: 1500,
    currentPrice: 180, marketValue: 1800, gainLoss: 300, gainLossPercent: 20, costBasisAccountCurrency: 1500,
    accountBreakdowns: [
      { id: 'h-1', accountId: 'acc-1', securityId: 's-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD', quantity: 10, averageCost: 150, costBasis: 1500, currentPrice: 180, marketValue: 1800, gainLoss: 300, gainLossPercent: 20, costBasisAccountCurrency: 1500 },
    ],
  },
];

// Two trades and two dividends. Default sort is date descending on both tables,
// so the June rows lead. Totals are distinct so a sort by amount reorders them.
const TRANSACTIONS = [
  { id: 'tx1', transactionDate: '2024-06-15', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'Apple Inc.' }, accountId: 'acc-1' },
  { id: 'tx2', transactionDate: '2024-03-10', action: 'SELL', quantity: 5, price: 180, totalAmount: 900, securityId: 's-1', security: { symbol: 'AAPL', name: 'Apple Inc.' }, accountId: 'acc-1' },
  { id: 'd1', transactionDate: '2024-05-01', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'Apple Inc.' }, accountId: 'acc-1' },
  { id: 'd2', transactionDate: '2024-02-01', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 30, securityId: 's-1', security: { symbol: 'AAPL', name: 'Apple Inc.' }, accountId: 'acc-1' },
];

const SELECT_PLACEHOLDER = 'Select securities...';

async function selectSecurity(optionLabel: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: SELECT_PLACEHOLDER }));
  });
  await act(async () => {
    fireEvent.click(screen.getByText(optionLabel));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: SELECT_PLACEHOLDER }));
  });
}

async function renderAt(view: 'Transactions' | 'Dividends') {
  mockGetSecurities.mockResolvedValue(mockSecurities);
  mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
  mockGetSecurityPrices.mockResolvedValue([]);
  mockGetTransactions.mockResolvedValue({ data: TRANSACTIONS, pagination: { hasMore: false } });
  mockGetInvestmentAccounts.mockResolvedValue([{ id: 'acc-1', name: 'Brokerage 1', currencyCode: 'USD' }]);
  mockGetMarketIndexes.mockResolvedValue([]);

  let container!: HTMLElement;
  await act(async () => {
    container = render(<SecurityPerformanceReport />).container;
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument(),
  );
  await selectSecurity('AAPL - Apple Inc.');
  await waitFor(() => expect(screen.getByText(view)).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByText(view));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${row}`;
};

const stripGlyph = (el: Element) => el.textContent?.replace(/[↑↓↕]/g, '').trim();

describe('SecurityPerformanceReport transactions table (phone wrapped)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a table from sm up and a grid below it, with the semantics a restyle strips', async () => {
    const container = await renderAt('Transactions');

    const table = container.querySelector('table')!;
    expect(table.getAttribute('role')).toBe('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    for (const group of container.querySelectorAll('thead, tbody')) {
      expect(group.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of container.querySelectorAll('tbody tr')) {
      expect(row.getAttribute('role')).toBe('row');
      expect(row.className).toContain('grid grid-cols-3');
      expect(row.className).toContain('sm:table-row');
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    const cells = Array.from(container.querySelectorAll('td'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    for (const th of container.querySelectorAll('th')) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
    // The wrapper still scrolls horizontally, which is what the table needs from
    // `sm` up on a narrow desktop window.
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('places every cell on the phone grid explicitly, derived figure beside its identity', async () => {
    const container = await renderAt('Transactions');

    // Line 1: date | action | total. Line 2: account | shares | price. DOM order
    // is the desktop column order (date, account, action, shares, price, total),
    // so placement is read off the classes rather than off position.
    for (const row of container.querySelectorAll('tbody tr')) {
      const [date, account, action, shares, price, total] = Array.from(row.querySelectorAll('td'));
      expect(placement(date)).toBe('c1/r1');
      expect(placement(account)).toBe('c1/r2');
      expect(placement(action)).toBe('c2/r1');
      expect(placement(shares)).toBe('c2/r2');
      expect(placement(price)).toBe('c3/r2');
      expect(placement(total)).toBe('c3/r1');
      // Explicit placement, never auto-flow.
      for (const cell of [date, account, action, shares, price, total]) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('captions every bare figure with its column key, and leaves the date and pill self-naming', async () => {
    const container = await renderAt('Transactions');

    const buyRow = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('$1500.00'),
    )!;
    // Each caption sits beside the value it names, as its own text node, so a
    // value lookup still matches the value node.
    expect(buyRow.textContent).toContain('Account' + 'Brokerage 1');
    expect(buyRow.textContent).toContain('Shares' + '10');
    expect(buyRow.textContent).toContain('Price' + '$150.00');
    expect(buyRow.textContent).toContain('Total' + '$1500.00');
    // The date is the identity and the action is a self-describing pill, so
    // neither carries a caption.
    const date = buyRow.querySelector('.col-start-1.row-start-1')!;
    expect(date.textContent).toBe('Jun 15, 2024');
    expect(date.querySelector('span')).toBeNull();
    const action = buyRow.querySelector('.col-start-2.row-start-1')!;
    // The pill itself is the only span in the action cell; there is no caption.
    expect(action.querySelectorAll('span')).toHaveLength(1);
    expect(action.querySelector('span')?.textContent).toBe('BUY');
    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of ['Date', 'Account', 'Action', 'Shares', 'Price', 'Total']) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('never wraps a money or share figure, and gives each caption whitespace-normal back', async () => {
    const container = await renderAt('Transactions');

    for (const row of container.querySelectorAll('tbody tr')) {
      // The three figure cells (shares, price, total) are right-aligned and
      // never wrap; the account may wrap and the date never wraps but is not a
      // figure.
      const figures = Array.from(row.querySelectorAll('td')).filter(
        (c) => c.className.includes('whitespace-nowrap') && c.className.includes('text-right'),
      );
      expect(figures).toHaveLength(3);
      for (const cell of figures) {
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
      // The account cell wraps a translated name; it is not right-aligned.
      const account = row.querySelector('.col-start-1.row-start-2')!;
      expect(account.className).not.toContain('whitespace-nowrap');
      expect(account.className).toContain('break-words');
    }
  });

  it('restores this table’s own cell padding from sm up, per cell', async () => {
    const container = await renderAt('Transactions');

    for (const cell of container.querySelectorAll('tbody td')) {
      // No padding of its own below `sm`; the row supplies it. This table's
      // `px-4 py-3` restored from `sm` up.
      expect(cell.className).toContain('p-0');
      expect(cell.className).toContain('sm:px-4');
      expect(cell.className).toContain('sm:py-3');
    }
  });

  it('offers the same six sort controls on phones as in the column header', async () => {
    const container = await renderAt('Transactions');

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    const labelsOf = (row: Element) => Array.from(row.querySelectorAll('th')).map(stripGlyph);
    const expected = ['Date', 'Account', 'Action', 'Shares', 'Price', 'Total'];
    expect(labelsOf(phoneRow)).toEqual(expected);
    // Both rows are rendered from one list, so they cannot list different fields.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderAt('Transactions');

    const dateOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('.col-start-1.row-start-1')?.textContent,
      );
    // Default sort is date descending: June leads March.
    expect(dateOrder()).toEqual(['Jun 15, 2024', 'Mar 10, 2024']);

    // "Total" in the phone strip is the sixth of the six controls in the first
    // header row. Addressed by position because the label also appears in the
    // column header row and in a caption.
    const phoneTotal = container.querySelectorAll('thead tr')[0].querySelectorAll('th')[5];
    await act(async () => {
      fireEvent.click(phoneTotal);
    });
    // Ascending by total puts the $900 SELL (March) first.
    expect(dateOrder()).toEqual(['Mar 10, 2024', 'Jun 15, 2024']);
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderAt('Transactions');

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('SecurityPerformanceReport dividends table (phone wrapped)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps each dividend row onto a two-column grid, amount beside the date', async () => {
    const container = await renderAt('Dividends');

    const table = container.querySelector('table')!;
    expect(table.getAttribute('role')).toBe('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');

    for (const row of container.querySelectorAll('tbody tr')) {
      expect(row.className).toContain('grid grid-cols-2');
      expect(row.className).toContain('sm:table-row');
      const [date, account, type, amount] = Array.from(row.querySelectorAll('td'));
      expect(placement(date)).toBe('c1/r1');
      expect(placement(account)).toBe('c1/r2');
      expect(placement(type)).toBe('c2/r2');
      expect(placement(amount)).toBe('c2/r1');
      for (const cell of [date, account, type, amount]) {
        expect(cell.getAttribute('role')).toBe('cell');
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
    }
  });

  it('captions the amount and account, and leaves the date and type pill self-naming', async () => {
    const container = await renderAt('Dividends');

    const row = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('$50.00'),
    )!;
    expect(row.textContent).toContain('Account' + 'Brokerage 1');
    expect(row.textContent).toContain('Amount' + '$50.00');
    const date = row.querySelector('.col-start-1.row-start-1')!;
    expect(date.textContent).toBe('May 1, 2024');
    expect(date.querySelector('span')).toBeNull();
    const type = row.querySelector('.col-start-2.row-start-2')!;
    expect(type.querySelectorAll('span')).toHaveLength(1);
    expect(type.querySelector('span')?.textContent).toBe('DIVIDEND');
    // The amount never wraps; its caption takes whitespace-normal back.
    const amount = row.querySelector('.col-start-2.row-start-1')!;
    expect(amount.className).toContain('whitespace-nowrap');
    expect(amount.className).toContain('text-right');
    expect(amount.querySelector('span')?.className).toContain('whitespace-normal');
    expect(amount.querySelector('span')?.className).toContain('sm:hidden');
  });

  it('offers the same four sort controls on phones as in the column header', async () => {
    const container = await renderAt('Dividends');

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');
    const labelsOf = (r: Element) => Array.from(r.querySelectorAll('th')).map(stripGlyph);
    expect(labelsOf(phoneRow)).toEqual(['Date', 'Account', 'Type', 'Amount']);
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it('wraps the footer like a data row and states aria-colindex on its colspan cells', async () => {
    const container = await renderAt('Dividends');

    const foot = container.querySelector('tfoot')!;
    expect(foot.getAttribute('role')).toBe('rowgroup');
    expect(foot.className).toContain('sm:table-footer-group');
    const footRow = foot.querySelector('tr')!;
    expect(footRow.getAttribute('role')).toBe('row');
    expect(footRow.className).toContain('grid grid-cols-2');

    const [label, total] = Array.from(footRow.querySelectorAll('td'));
    // "Total Dividends" stands in for the identity and keeps its desktop
    // `colSpan={3}`; its cells do not map one-to-one to the body columns, so
    // each states its column index.
    expect(label.getAttribute('colspan')).toBe('3');
    expect(label.getAttribute('aria-colindex')).toBe('1');
    expect(placement(label)).toBe('c1/r1');
    expect(label.textContent).toBe('Total Dividends');
    // The total sits beside the label; it names itself from that label, so it
    // carries no caption, and it never wraps.
    expect(total.getAttribute('aria-colindex')).toBe('4');
    expect(placement(total)).toBe('c2/r1');
    expect(total.querySelector('span')).toBeNull();
    expect(total.className).toContain('whitespace-nowrap');
    expect(total.className).toContain('text-right');
    // 50 + 30.
    expect(total.textContent).toBe('$80.00');
  });
});
