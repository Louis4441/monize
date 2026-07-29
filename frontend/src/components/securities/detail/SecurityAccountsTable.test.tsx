import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityAccountsTable } from './SecurityAccountsTable';
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
    accountCurrencyCode: 'EUR',
    isClosed: false,
    quantity: 60,
    averageCost: 100,
    costBasis: 6000,
    costBasisAccountCurrency: 6000,
    marketValue: 7200,
    gainLoss: 1200,
    gainLossPercent: 20,
    ...overrides,
  };
}

function detail(
  accounts: SecurityDetailAccountPosition[],
  overrides: Partial<SecurityDetail> = {},
): SecurityDetail {
  return {
    security: security(),
    position: {
      quantity: 60,
      averageCost: 100,
      currentPrice: 120,
      costBasis: 6000,
      marketValue: 7200,
      gainLoss: 1200,
      gainLossPercent: 20,
    },
    accounts,
    activity: {
      firstTransactionDate: '2024-01-01',
      lastTransactionDate: '2024-01-01',
      totalInvested: 6000,
      totalSold: 0,
      dividends: 0,
      fees: 0,
      realizedGain: null,
      realizedGainCurrency: null,
      realizedGainCurrencies: [],
      realizedSaleCount: 0,
      transactionCount: 1,
    },
    hasTransactions: true,
    isPositionClosed: false,
    ...overrides,
  };
}

describe('SecurityAccountsTable', () => {
  it('renders nothing when no account holds the security', () => {
    const { container } = render(<SecurityAccountsTable detail={detail([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the account with its units, value and gain', () => {
    render(<SecurityAccountsTable detail={detail([account()])} />);
    expect(screen.getByText('Brokerage')).toBeInTheDocument();
    expect(screen.getAllByText('€7,200.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\+€1,200\.00/).length).toBeGreaterThan(0);
  });

  it('marks a position stranded in a closed account', () => {
    render(
      <SecurityAccountsTable detail={detail([account({ isClosed: true })])} />,
    );
    // The portfolio summary skips closed accounts, so this row exists only
    // because the position comes from the transaction history instead.
    expect(screen.getByText('Brokerage (closed)')).toBeInTheDocument();
  });

  describe('multi-currency', () => {
    it('shows the cost basis in the account currency as well', () => {
      render(
        <SecurityAccountsTable
          detail={detail([
            account({
              accountCurrencyCode: 'PLN',
              costBasisAccountCurrency: 25800,
            }),
          ])}
        />,
      );
      // Both, as the maintainer asked: the security's own currency and the
      // account's, the latter at the historical rates on the buy legs.
      expect(screen.getAllByText('€6,000.00').length).toBeGreaterThan(0);
      expect(screen.getByText(/25,800/)).toBeInTheDocument();
    });

    it('adds no second line when the account is in the security currency', () => {
      render(<SecurityAccountsTable detail={detail([account()])} />);
      // A duplicate figure in the same currency is noise.
      expect(screen.getAllByText('€6,000.00')).toHaveLength(2); // row + total
    });

    it('adds no second line without a converted figure to show', () => {
      render(
        <SecurityAccountsTable
          detail={detail([
            account({
              accountCurrencyCode: 'PLN',
              costBasisAccountCurrency: null,
            }),
          ])}
        />,
      );
      expect(screen.getByText('PLN')).toBeInTheDocument();
      expect(screen.queryByText(/zł/)).not.toBeInTheDocument();
    });
  });

  describe('unknown values', () => {
    it('marks an unpriced row rather than showing it as worthless', () => {
      render(
        <SecurityAccountsTable
          detail={detail([
            account({
              averageCost: null,
              costBasis: null,
              marketValue: null,
              gainLoss: null,
              gainLossPercent: null,
            }),
          ])}
        />,
      );
      // Four cells on the row, plus the totals that inherit the same gap.
      expect(screen.getAllByText('Not priced').length).toBeGreaterThanOrEqual(4);
      expect(screen.queryByText('€0.00')).not.toBeInTheDocument();
    });

    it('omits the percentage when only the amount is known', () => {
      const base = detail([account({ gainLossPercent: null })]);
      render(
        <SecurityAccountsTable
          detail={{
            ...base,
            // The totals row derives its own percentage, so it has to be absent
            // there too for the assertion to be about the row at all.
            position: { ...base.position, gainLossPercent: null },
          }}
        />,
      );
      expect(screen.queryByText('+20.00%')).not.toBeInTheDocument();
      expect(screen.getAllByText(/\+€1,200\.00/).length).toBeGreaterThan(0);
    });
  });

  it('shows a dash for an account with no currency code', () => {
    render(
      <SecurityAccountsTable
        detail={detail([account({ accountCurrencyCode: null })])}
      />,
    );
    expect(screen.getByText('-')).toBeInTheDocument();
  });
});
