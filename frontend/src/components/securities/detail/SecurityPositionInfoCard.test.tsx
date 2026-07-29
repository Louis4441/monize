import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityPositionInfoCard } from './SecurityPositionInfoCard';
import type {
  Security,
  SecurityDetail,
  SecurityDetailActivity,
  SecurityDetailPosition,
} from '@/types/investment';

function security(overrides: Partial<Security> = {}): Security {
  return {
    id: 'sec-1',
    symbol: 'IUSQ',
    name: 'All World',
    securityType: 'ETF',
    exchange: 'XETRA',
    currencyCode: 'EUR',
    description: null,
    tags: [],
    isActive: true,
    isFavourite: false,
    skipPriceUpdates: false,
    sector: null,
    industry: null,
    sectorWeightings: null,
    countryWeightings: null,
    assetWeightings: null,
    quoteProvider: 'yahoo',
    msnInstrumentId: null,
    lastPriceSource: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function position(
  overrides: Partial<SecurityDetailPosition> = {},
): SecurityDetailPosition {
  return {
    quantity: 100,
    averageCost: 100,
    currentPrice: 130,
    costBasis: 10000,
    marketValue: 13000,
    gainLoss: 3000,
    gainLossPercent: 30,
    ...overrides,
  };
}

function activity(
  overrides: Partial<SecurityDetailActivity> = {},
): SecurityDetailActivity {
  return {
    firstTransactionDate: '2022-03-12',
    lastTransactionDate: '2026-06-20',
    totalInvested: 10000,
    totalSold: 0,
    dividends: 200,
    fees: 50,
    realizedGain: null,
    realizedGainCurrency: null,
    realizedGainCurrencies: [],
    realizedSaleCount: 0,
    transactionCount: 4,
    ...overrides,
  };
}

function detail(overrides: Partial<SecurityDetail> = {}): SecurityDetail {
  return {
    security: security(),
    position: position(),
    accounts: [],
    activity: activity(),
    hasTransactions: true,
    isPositionClosed: false,
    ...overrides,
  };
}

describe('SecurityPositionInfoCard', () => {
  it('reports the lifetime totals in the security currency', () => {
    render(<SecurityPositionInfoCard detail={detail()} />);
    expect(screen.getByText('€10,000.00')).toBeInTheDocument();
    expect(screen.getByText('€200.00')).toBeInTheDocument();
    expect(screen.getByText('€50.00')).toBeInTheDocument();
  });

  describe('status', () => {
    it('calls a never-traded security never held', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({ hasTransactions: false })}
        />,
      );
      expect(screen.getByText('Never held')).toBeInTheDocument();
    });

    it('calls a sold-out position closed', () => {
      render(
        <SecurityPositionInfoCard detail={detail({ isPositionClosed: true })} />,
      );
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });

    it('calls a held position open', () => {
      render(<SecurityPositionInfoCard detail={detail()} />);
      expect(screen.getByText('Open')).toBeInTheDocument();
    });
  });

  describe('realized P/L', () => {
    it('shows the gain in the currency the replay denominated it in', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: 750.5,
              realizedGainCurrency: 'PLN',
              realizedGainCurrencies: ['PLN'],
              realizedSaleCount: 2,
            }),
          })}
        />,
      );
      // PLN, not the security's EUR: the average-cost replay works in the
      // holding account's currency and this page converts nothing.
      expect(screen.getByText(/750\.50/)).toBeInTheDocument();
      expect(screen.queryByText(/€750\.50/)).not.toBeInTheDocument();
    });

    it('names the currencies instead of going blank when they differ', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: null,
              realizedGainCurrency: null,
              realizedGainCurrencies: ['EUR', 'PLN'],
              realizedSaleCount: 3,
            }),
          })}
        />,
      );
      // A blank row is how "you never sold" reads. Saying the gains exist but
      // sit in two currencies is a different statement, and the true one.
      expect(
        screen.getByText('Realized in EUR, PLN, so not added up'),
      ).toBeInTheDocument();
    });

    it('leaves the row out entirely when nothing was ever sold', () => {
      render(<SecurityPositionInfoCard detail={detail()} />);
      expect(screen.queryByText(/Realized P\/L/)).not.toBeInTheDocument();
    });
  });

  describe('total return', () => {
    it('adds income and realized gains to the unrealized gain', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: 500,
              realizedGainCurrency: 'EUR',
              realizedGainCurrencies: ['EUR'],
              realizedSaleCount: 1,
            }),
          })}
        />,
      );
      // 3000 unrealized + 500 realized + 200 income - 50 fees = 3650 on 10000.
      expect(screen.getByText(/\+€3,650\.00/)).toBeInTheDocument();
      expect(screen.getByText(/\+36\.50%/)).toBeInTheDocument();
    });

    it('counts only income and fees for a security still held but never sold', () => {
      render(<SecurityPositionInfoCard detail={detail()} />);
      // 3000 + 200 - 50 = 3150 on 10000.
      expect(screen.getByText(/\+€3,150\.00/)).toBeInTheDocument();
    });

    it('is withheld when the realized gain sits in another currency', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: 500,
              realizedGainCurrency: 'PLN',
              realizedGainCurrencies: ['PLN'],
              realizedSaleCount: 1,
            }),
          })}
        />,
      );
      // Adding PLN to EUR would need a rate this page has no business applying.
      expect(screen.queryByText('Total return')).not.toBeInTheDocument();
    });

    it('is withheld when the position could not be priced', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            position: position({
              marketValue: null,
              costBasis: null,
              gainLoss: null,
              gainLossPercent: null,
            }),
          })}
        />,
      );
      expect(screen.queryByText('Total return')).not.toBeInTheDocument();
    });

    it('needs no market value once the position is closed', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            isPositionClosed: true,
            position: position({
              quantity: 0,
              marketValue: null,
              costBasis: null,
              gainLoss: null,
              gainLossPercent: null,
            }),
            activity: activity({
              totalSold: 11000,
              realizedGain: 900,
              realizedGainCurrency: 'EUR',
              realizedGainCurrencies: ['EUR'],
              realizedSaleCount: 1,
            }),
          })}
        />,
      );
      // Nothing is held, so there is no unrealized part to be unable to price:
      // 900 realized + 200 income - 50 fees = 1050.
      expect(screen.getByText(/\+€1,050\.00/)).toBeInTheDocument();
    });
  });
});
