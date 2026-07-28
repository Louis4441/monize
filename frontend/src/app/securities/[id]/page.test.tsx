import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@/test/render';
import SecurityDetailPage from './page';
import type { Security, SecurityDetail } from '@/types/investment';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/securities/sec-1',
  useParams: () => ({ id: 'sec-1' }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = {
        user: {
          id: 'user-1',
          email: 'test@example.com',
          role: 'user',
          hasPassword: true,
        },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'user-1', email: 'test@example.com', role: 'user' },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

// The chart has its own tests; stub it so this page test does not depend on
// Recharts measuring a zero-size container.
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="chart">{data.length}</div>
  ),
}));

const mockGetSecurityDetail = vi.fn();
const mockGetSecurityPrices = vi.fn();
const mockGetSecurityTransactionHistory = vi.fn();
const mockSetSecurityFavourite = vi.fn();
const mockBackfillSecurityPrices = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityDetail: (...args: unknown[]) => mockGetSecurityDetail(...args),
    getSecurityPrices: (...args: unknown[]) => mockGetSecurityPrices(...args),
    getSecurityTransactionHistory: (...args: unknown[]) =>
      mockGetSecurityTransactionHistory(...args),
    setSecurityFavourite: (...args: unknown[]) =>
      mockSetSecurityFavourite(...args),
    backfillSecurityPrices: (...args: unknown[]) =>
      mockBackfillSecurityPrices(...args),
    updateSecurity: vi.fn(),
  },
}));

const security: Security = {
  id: 'sec-1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  securityType: 'STOCK',
  exchange: 'NASDAQ',
  currencyCode: 'USD',
  description: 'Apple designs and sells consumer electronics.',
  tags: [],
  isActive: true,
  isFavourite: false,
  skipPriceUpdates: false,
  sector: 'Technology',
  industry: 'Consumer Electronics',
  sectorWeightings: null,
  countryWeightings: null,
  quoteProvider: 'yahoo',
  msnInstrumentId: null,
  lastPriceSource: 'yahoo_finance',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function detailFixture(overrides: Partial<SecurityDetail> = {}): SecurityDetail {
  return {
    security,
    position: {
      quantity: 100,
      averageCost: 120,
      currentPrice: 150,
      costBasis: 12000,
      marketValue: 15000,
      gainLoss: 3000,
      gainLossPercent: 25,
    },
    accounts: [
      {
        accountId: 'acct-1',
        accountName: 'Brokerage',
        accountCurrencyCode: 'PLN',
        isClosed: false,
        quantity: 60,
        averageCost: 120,
        costBasis: 7200,
        costBasisAccountCurrency: 28800,
        marketValue: 9000,
        gainLoss: 1800,
        gainLossPercent: 25,
      },
      {
        accountId: 'acct-2',
        accountName: 'IKE',
        accountCurrencyCode: 'PLN',
        isClosed: false,
        quantity: 40,
        averageCost: 120,
        costBasis: 4800,
        costBasisAccountCurrency: 19200,
        marketValue: 6000,
        gainLoss: 1200,
        gainLossPercent: 25,
      },
    ],
    activity: {
      firstTransactionDate: '2022-03-12',
      lastTransactionDate: '2026-06-20',
      totalInvested: 12000,
      totalSold: 0,
      dividends: 320.5,
      fees: 48.3,
      realizedGain: null,
      realizedGainCurrency: null,
      transactionCount: 4,
    },
    hasTransactions: true,
    isPositionClosed: false,
    ...overrides,
  };
}

async function renderPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<SecurityDetailPage />);
  });
  return result!;
}

describe('SecurityDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecurityDetail.mockResolvedValue(detailFixture());
    mockGetSecurityPrices.mockResolvedValue([
      {
        id: 2,
        securityId: 'sec-1',
        priceDate: '2026-07-28',
        openPrice: null,
        highPrice: null,
        lowPrice: null,
        closePrice: 150,
        volume: null,
        source: 'yahoo_finance',
        createdAt: '2026-07-28T00:00:00.000Z',
      },
      {
        id: 1,
        securityId: 'sec-1',
        priceDate: '2026-07-27',
        openPrice: null,
        highPrice: null,
        lowPrice: null,
        closePrice: 145,
        volume: null,
        source: 'yahoo_finance',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ]);
    mockGetSecurityTransactionHistory.mockResolvedValue({
      securityId: 'sec-1',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currencyCode: 'USD',
      isActive: true,
      accounts: [],
      transactions: [],
      currentQuantityAll: 100,
    });
  });

  it('names the security as the page heading', async () => {
    await renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Apple Inc.' }),
    ).toBeInTheDocument();
  });

  it('shows the classification below the name rather than in it', async () => {
    await renderPage();
    expect(screen.getByText(/AAPL.*Stock.*NASDAQ.*USD/)).toBeInTheDocument();
  });

  it('reports the load failure with a way to retry', async () => {
    mockGetSecurityDetail.mockRejectedValue(new Error('boom'));
    await renderPage();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument();
  });

  it('keeps the page usable when only the price history fails', async () => {
    mockGetSecurityPrices.mockRejectedValue(new Error('no prices'));
    await renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Apple Inc.' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('goes back to the securities list', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Securities/ }));
    });
    expect(mockPush).toHaveBeenCalledWith('/securities');
  });

  describe('summary', () => {
    it('shows the position value in the reporting currency', async () => {
      await renderPage();
      expect(
        screen.getByRole('article', { name: 'Market value' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('article', { name: 'Cost basis' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('article', { name: 'Unrealized P/L' }),
      ).toBeInTheDocument();
    });

    it('lists each holding account with its share of the position', async () => {
      await renderPage();
      const card = screen.getByRole('article', { name: 'Held in accounts' });
      expect(card).toHaveTextContent('Brokerage');
      expect(card).toHaveTextContent('IKE');
      expect(card).toHaveTextContent('60.00%');
      expect(card).toHaveTextContent('40.00%');
    });

    it('replaces the cards with a closed-position panel once nothing is held', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({
          accounts: [],
          isPositionClosed: true,
          activity: {
            ...detailFixture().activity,
            realizedGain: 2340,
            realizedGainCurrency: 'PLN',
          },
        }),
      );
      await renderPage();
      expect(screen.getByText('Position closed')).toBeInTheDocument();
      // No zero-filled figures standing in for a position that is not there.
      expect(
        screen.queryByRole('article', { name: 'Market value' }),
      ).not.toBeInTheDocument();
    });

    it('distinguishes a never-held security from a closed one', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({
          accounts: [],
          hasTransactions: false,
          isPositionClosed: false,
        }),
      );
      await renderPage();
      expect(screen.getByText('No position data')).toBeInTheDocument();
      expect(screen.queryByText('Position closed')).not.toBeInTheDocument();
    });
  });

  describe('tabs', () => {
    it('opens on Overview and offers the other sections', async () => {
      await renderPage();
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: 'Transactions' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Price history' })).toBeInTheDocument();
    });

    it('does not offer Documents yet', async () => {
      await renderPage();
      expect(
        screen.queryByRole('tab', { name: 'Documents' }),
      ).not.toBeInTheDocument();
    });

    it('gives Overview the two full-width sections', async () => {
      await renderPage();
      expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Accounts' }),
      ).toBeInTheDocument();
    });

    it('switches to the price history table on demand', async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'Price history' }));
      });
      expect(screen.getByRole('tab', { name: 'Price history' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(
        screen.queryByRole('heading', { name: 'About' }),
      ).not.toBeInTheDocument();
    });

    it('keeps the cards beside the chart visible whichever tab is open', async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'Transactions' }));
      });
      // They sit above the tabs, not inside Overview, so switching tab does not
      // take the key figures off the screen.
      for (const name of ['Key information', 'Performance', 'Position info']) {
        expect(screen.getByRole('heading', { name })).toBeInTheDocument();
      }
    });
  });

  describe('chart', () => {
    it('offers the three series and starts on price', async () => {
      await renderPage();
      expect(screen.getByRole('button', { name: 'Price' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        screen.getByRole('button', { name: 'Investment value' }),
      ).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Return' })).toBeInTheDocument();
    });

    it('switches series without reloading the page data', async () => {
      await renderPage();
      mockGetSecurityDetail.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Return' }));
      });
      expect(screen.getByRole('button', { name: 'Return' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(mockGetSecurityDetail).not.toHaveBeenCalled();
    });
  });

  describe('watchlist', () => {
    it('adds the security and reflects it on the button', async () => {
      mockSetSecurityFavourite.mockResolvedValue({
        ...security,
        isFavourite: true,
      });
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Watch/ }));
      });
      expect(mockSetSecurityFavourite).toHaveBeenCalledWith('sec-1', true);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /Watching/ }),
        ).toBeInTheDocument(),
      );
    });

    it('leaves the button alone when the update fails', async () => {
      mockSetSecurityFavourite.mockRejectedValue(new Error('nope'));
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Watch/ }));
      });
      await act(async () => {});
      expect(
        screen.getByRole('button', { name: /Watch/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Watching/ }),
      ).not.toBeInTheDocument();
    });
  });
});
