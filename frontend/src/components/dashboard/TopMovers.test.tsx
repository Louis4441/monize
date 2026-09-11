import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TopMovers, rankMovers } from './TopMovers';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyPrecise: (n: number) => {
        const abs = Math.abs(n);
        let digits = 2;
        if (n !== 0 && abs < 0.005) {
          const exp = Math.floor(Math.log10(abs));
          digits = Math.min(6, Math.max(2, -exp + 2));
        }
        return `$${n.toFixed(digits)}`;
      },
      formatPercent: (n: number) => `${n.toFixed(2)}%`,
    }),
  };
});
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: any) => selector({ preferences: { defaultCurrency: 'USD' } }),
}));

describe('TopMovers', () => {
  beforeEach(() => {
    mockPush.mockClear();
    localStorage.clear();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<TopMovers movers={[]} isLoading={true} hasInvestmentAccounts={true} />);
    expect(screen.getByText('Top Movers')).toBeInTheDocument();
    expect(screen.getByText('Daily change')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state with no investment accounts', () => {
    render(<TopMovers movers={[]} isLoading={false} hasInvestmentAccounts={false} />);
    expect(screen.getByText('Add investment accounts to track daily movers.')).toBeInTheDocument();
  });

  it('renders empty state with investment accounts but no movers', () => {
    render(<TopMovers movers={[]} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('No price changes available yet.')).toBeInTheDocument();
  });

  it('renders movers with symbol, name, and price', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple Inc.', currentPrice: 180, dailyChange: 5.5, dailyChangePercent: 3.15, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2.0, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('$180.00')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('Microsoft')).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
  });

  it('expands precision for sub-penny movers instead of showing 0.00', () => {
    const movers = [
      { securityId: '1', symbol: 'PENNY', name: 'Sub-penny Co', currentPrice: 0.000318, dailyChange: 0.000033, dailyChangePercent: 11.4, currencyCode: 'GBP' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    // Price and change reveal their real figures rather than collapsing to 0.00.
    expect(screen.getByText(/0\.000318/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$0\.000033 \(\+11\.40%\)/)).toBeInTheDocument();
  });

  it('shows positive change with plus sign and green color', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5.5, dailyChangePercent: 3.15, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    const changeEl = screen.getByText(/\+\$5\.50/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-green');
  });

  it('shows negative change with red color', () => {
    const movers = [
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2.0, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    const changeEl = screen.getByText(/\$-2\.00/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-red');
  });

  it('shows View portfolio link and navigates on click', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('View portfolio'));
    expect(mockPush).toHaveBeenCalledWith('/investments');
  });

  it('links the title to investments', () => {
    render(<TopMovers movers={[]} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByRole('link', { name: 'Top Movers' })).toHaveAttribute(
      'href',
      '/investments',
    );
  });

  it('shows the five biggest movers, not the first five it was handed', () => {
    // Daily changes of -8, -6, -4, -2, 0, 2, 4, 6: the five largest moves in
    // either direction are SYM0, SYM1, SYM7, SYM2 and SYM6. SYM4 did not move
    // and is nobody's top mover, whatever position it arrived in.
    const movers = Array.from({ length: 8 }, (_, i) => ({
      securityId: `${i}`, symbol: `SYM${i}`, name: `Company ${i}`,
      currentPrice: 100 + i, dailyChange: (i - 4) * 2, dailyChangePercent: (i - 4) * 0.5,
      currencyCode: 'USD',
    })) as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);

    expect(screen.getAllByRole('button', { name: /Price history for/ })).toHaveLength(5);
    expect(screen.getByText('SYM0')).toBeInTheDocument();
    expect(screen.getByText('SYM7')).toBeInTheDocument();
    expect(screen.queryByText('SYM4')).not.toBeInTheDocument();
  });

  it('renders the All/Gainers/Losers filter selector', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Gainers')).toBeInTheDocument();
    expect(screen.getByText('Losers')).toBeInTheDocument();
  });

  it('filters to only gainers when Gainers is selected', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Gainers'));
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.queryByText('MSFT')).not.toBeInTheDocument();
  });

  it('filters to only losers when Losers is selected', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Losers'));
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });

  it('persists the selected filter to localStorage and restores it on remount', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    const { unmount } = render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Losers'));
    expect(localStorage.getItem('dashboard.topMovers.filter')).toBe('losers');
    unmount();

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });

  it('shows an empty message when the selected filter has no matches', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Losers'));
    expect(screen.getByText('No losers today.')).toBeInTheDocument();
  });

  it('shows refresh button when onRefresh is provided', () => {
    const onRefresh = vi.fn();
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} onRefresh={onRefresh} />);
    const refreshBtn = screen.getByTitle('Refresh prices');
    expect(refreshBtn).toBeInTheDocument();
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalled();
  });

  it('disables refresh button when isRefreshing is true', () => {
    const onRefresh = vi.fn();
    render(<TopMovers movers={[]} isLoading={true} hasInvestmentAccounts={true} onRefresh={onRefresh} isRefreshing={true} />);
    const refreshBtn = screen.getByTitle('Refresh prices');
    expect(refreshBtn).toBeDisabled();
  });

  it('shows currency code for foreign securities', () => {
    const movers = [
      { securityId: '1', symbol: 'BMW', name: 'BMW AG', currentPrice: 95, dailyChange: 2, dailyChangePercent: 2.1, currencyCode: 'EUR' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    // Foreign currency should show currency code after amount
    expect(screen.getByText('$95.00 EUR')).toBeInTheDocument();
  });

  it('opens the security\'s price history when a row is clicked', () => {
    const movers = [
      { securityId: 'sec-1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    // The row names itself with its own content; the action is screen-reader
    // text inside it, not an aria-label that would hide the price and change.
    const row = screen.getByRole('button', { name: /Price history for AAPL/ });
    expect(row).toHaveAccessibleName(expect.stringContaining('Apple'));
    expect(row).toHaveAccessibleName(expect.stringContaining('$180.00'));
    fireEvent.click(row);

    // The detail page's Price history tab, which replaced the modal the
    // securities list used to open, reached
    // by deep link rather than by a second copy of it on the dashboard.
    expect(mockPush).toHaveBeenCalledWith('/securities/sec-1?tab=prices');
  });

  it('re-ranks the list when the rank-by toggle changes, and remembers it', () => {
    // In the order the server sends: biggest percentage move first. Both
    // settings therefore have to reorder, so neither can look right by
    // accidentally inheriting the incoming order.
    const movers = [
      { securityId: '2', symbol: 'SMALL', name: 'Small', currentPrice: 20, dailyChange: 8, dailyChangePercent: 40, currencyCode: 'USD' },
      { securityId: '1', symbol: 'BIG', name: 'Big', currentPrice: 900, dailyChange: 400, dailyChangePercent: 0.5, currencyCode: 'USD' },
    ] as any[];

    const { unmount } = render(
      <TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />,
    );
    const symbolsInOrder = () =>
      screen.getAllByRole('button', { name: /Price history for/ }).map((row) =>
        row.textContent?.includes('BIG') ? 'BIG' : 'SMALL',
      );
    expect(symbolsInOrder()).toEqual(['BIG', 'SMALL']);

    fireEvent.click(screen.getByRole('button', { name: 'Percent' }));
    expect(symbolsInOrder()).toEqual(['SMALL', 'BIG']);

    // The choice is a per-browser convenience, kept across a remount.
    unmount();
    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByRole('button', { name: 'Percent' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('does not show currency code for default currency securities', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('$180.00')).toBeInTheDocument();
    // Should not have 'USD' appended
    expect(screen.queryByText('$180.00 USD')).not.toBeInTheDocument();
  });
});

describe('rankMovers', () => {
  // A big holding moves the most money on a small percentage; a small one moves
  // the most percent on very little. The two orders are genuinely different, so
  // each is pinned here rather than assumed to follow from the other.
  const mover = (symbol: string, dailyChange: number, dailyChangePercent: number) =>
    ({ securityId: symbol, symbol, name: symbol, currentPrice: 100, dailyChange, dailyChangePercent, currencyCode: 'USD' }) as any;

  /**
   * In the order the server sends: descending absolute daily change PERCENT.
   * The fixture is deliberately not in money order -- a branch that passed the
   * incoming order through showed the percent ranking under the Amount heading,
   * and a fixture already sorted by money could not tell the two apart.
   */
  const movers = [
    mover('SMALL', 8, 40),
    mover('MID', -120, -6),
    mover('BIG', 400, 0.5),
  ];

  it('ranks by the size of the money move for all + amount', () => {
    expect(rankMovers(movers, 'all', 'amount').map((m) => m.symbol)).toEqual([
      'BIG',
      'MID',
      'SMALL',
    ]);
  });

  it('re-ranks by the size of the percentage move for all + percent', () => {
    expect(rankMovers(movers, 'all', 'percent').map((m) => m.symbol)).toEqual([
      'SMALL',
      'MID',
      'BIG',
    ]);
  });

  it('ranks gainers by the chosen metric', () => {
    expect(rankMovers(movers, 'gainers', 'amount').map((m) => m.symbol)).toEqual([
      'BIG',
      'SMALL',
    ]);
    expect(rankMovers(movers, 'gainers', 'percent').map((m) => m.symbol)).toEqual([
      'SMALL',
      'BIG',
    ]);
  });

  it('ranks losers by the steepest fall under the chosen metric', () => {
    const losers = [mover('A', -50, -1), mover('B', -10, -25)];
    expect(rankMovers(losers, 'losers', 'amount').map((m) => m.symbol)).toEqual(['A', 'B']);
    expect(rankMovers(losers, 'losers', 'percent').map((m) => m.symbol)).toEqual(['B', 'A']);
  });

  it('takes at most the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => mover(`S${i}`, 9 - i, 9 - i));
    expect(rankMovers(many, 'all', 'amount')).toHaveLength(5);
  });

  it('leaves the caller\'s array alone', () => {
    const order = movers.map((m) => m.symbol);
    rankMovers(movers, 'all', 'percent');
    expect(movers.map((m) => m.symbol)).toEqual(order);
  });
});
