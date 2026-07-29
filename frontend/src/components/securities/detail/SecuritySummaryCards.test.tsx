import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecuritySummaryCards } from './SecuritySummaryCards';
import type {
  Security,
  SecurityDetail,
  SecurityDetailAccountPosition,
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

function account(
  overrides: Partial<SecurityDetailAccountPosition> = {},
): SecurityDetailAccountPosition {
  return {
    accountId: 'acct-1',
    accountName: 'Brokerage',
    accountCurrencyCode: 'PLN',
    isClosed: false,
    quantity: 60,
    averageCost: 100,
    costBasis: 6000,
    costBasisAccountCurrency: 24000,
    marketValue: 7200,
    gainLoss: 1200,
    gainLossPercent: 20,
    ...overrides,
  };
}

function detail(overrides: Partial<SecurityDetail> = {}): SecurityDetail {
  return {
    security: security(),
    position: {
      quantity: 100,
      averageCost: 120,
      currentPrice: 150,
      costBasis: 12000,
      marketValue: 15000,
      gainLoss: 3000,
      gainLossPercent: 25,
    },
    accounts: [account(), account({ accountId: 'acct-2', accountName: 'IKE', quantity: 40 })],
    activity: {
      firstTransactionDate: '2022-03-12',
      lastTransactionDate: '2026-06-20',
      totalInvested: 12000,
      totalSold: 0,
      dividends: 0,
      fees: 0,
      realizedGain: null,
      realizedGainCurrency: null,
      realizedGainCurrencies: [],
      realizedSaleCount: 0,
      transactionCount: 4,
    },
    hasTransactions: true,
    isPositionClosed: false,
    ...overrides,
  };
}

describe('SecuritySummaryCards', () => {
  it('shows the five figures in the security currency', () => {
    render(<SecuritySummaryCards detail={detail()} />);
    expect(screen.getByText('€15,000.00')).toBeInTheDocument();
    expect(screen.getByText('€12,000.00')).toBeInTheDocument();
    expect(screen.getByText('+€3,000.00')).toBeInTheDocument();
    expect(screen.getByText('+25.00%')).toBeInTheDocument();
  });

  describe('the unknown contract', () => {
    // The whole point of the null-vs-zero distinction: a zero market value is a
    // claim about worth, and "we could not price this" is not that claim. These
    // paths are what a holding in a closed account or a filtered dust residual
    // actually renders as, so they are the ones most worth pinning down.
    it('reports an unpriceable position as unknown rather than zero', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            position: {
              quantity: 100,
              averageCost: null,
              currentPrice: null,
              costBasis: null,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            },
          })}
        />,
      );
      // One per figure that could not be computed, and never a 0.00 among them.
      expect(screen.getAllByText('Not priced')).toHaveLength(4);
      expect(screen.queryByText('€0.00')).not.toBeInTheDocument();
    });

    it('drops the percentage when there is no gain to take one of', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            position: {
              quantity: 100,
              averageCost: 120,
              currentPrice: null,
              costBasis: 12000,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            },
          })}
        />,
      );
      expect(screen.queryByText('+0.00%')).not.toBeInTheDocument();
    });

    it('says so when no account holds the security', () => {
      render(<SecuritySummaryCards detail={detail({ accounts: [] })} />);
      expect(
        screen.getByText('This security is not held in any account.'),
      ).toBeInTheDocument();
    });
  });

  describe('dating the market value', () => {
    it('says which close the value was struck at', () => {
      render(
        <SecuritySummaryCards
          detail={detail()}
          quoteAsOf={{ priceDate: '2026-07-28', isCurrent: true }}
        />,
      );
      expect(screen.getByText(/At the close of/)).toBeInTheDocument();
    });

    it('flags a value struck at a price nobody has updated since', () => {
      render(
        <SecuritySummaryCards
          detail={detail()}
          quoteAsOf={{ priceDate: '2019-04-01', isCurrent: false }}
        />,
      );
      // Without this the card presents a 2019 valuation as today's worth.
      const note = screen.getByText(/the newest price on record/);
      expect(note).toBeInTheDocument();
      expect(note).toHaveAttribute('title', expect.stringContaining('No newer price'));
    });

    it('dates nothing when the position could not be priced at all', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            position: {
              quantity: 100,
              averageCost: 120,
              currentPrice: null,
              costBasis: 12000,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            },
          })}
          quoteAsOf={{ priceDate: '2026-07-28', isCurrent: true }}
        />,
      );
      // Dating a figure that is not there would imply there is one.
      expect(screen.queryByText(/At the close of/)).not.toBeInTheDocument();
    });
  });

  describe('held in accounts', () => {
    it('gives each account its units and share of the total', () => {
      render(<SecuritySummaryCards detail={detail()} />);
      expect(screen.getByText('60 (60.00%)')).toBeInTheDocument();
      expect(screen.getByText('40 (40.00%)')).toBeInTheDocument();
    });

    it('marks a position left in a closed account', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            accounts: [account({ isClosed: true })],
          })}
        />,
      );
      expect(screen.getByText('Brokerage (closed)')).toBeInTheDocument();
    });

    it('bounds the list with the slim scrollbar so the card keeps its height', () => {
      const { container } = render(
        <SecuritySummaryCards
          detail={detail({
            accounts: Array.from({ length: 10 }, (_, index) =>
              account({
                accountId: `acct-${index}`,
                accountName: `Account ${index}`,
                quantity: 10,
              }),
            ),
          })}
        />,
      );
      // This card sits in a row with five others; growing it drags the whole
      // grid down. The bar stays -- a bounded list needs one -- but it is the
      // slim one, because the native control is what looked broken.
      const list = container.querySelector('ul')!;
      expect(list.className).toContain('overflow-y-auto');
      expect(list.className).toMatch(/max-h-/);
      expect(list.className).toContain('scrollbar-slim');
      // Every account is still there to scroll to, not cut off.
      expect(list.querySelectorAll('li')).toHaveLength(10);
    });

    it('does not divide by a zero total when the balances cancel out', () => {
      render(
        <SecuritySummaryCards
          detail={detail({
            position: {
              quantity: 0,
              averageCost: null,
              currentPrice: 150,
              costBasis: null,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            },
            accounts: [
              account({ quantity: 10 }),
              account({ accountId: 'acct-2', accountName: 'IKE', quantity: -10 }),
            ],
          })}
        />,
      );
      // A share of nothing is 0%, not NaN% or Infinity%.
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
    });
  });
});
