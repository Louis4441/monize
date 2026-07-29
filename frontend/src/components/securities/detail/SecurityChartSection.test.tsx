import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityChartSection } from './SecurityChartSection';
import type { SecurityPricePoint } from '@/lib/security-detail';
import type {
  Security,
  SecurityHistoryTransaction,
} from '@/types/investment';

/**
 * The chart itself is covered by its own tests; what matters here is the props
 * this section decides -- which series, which snap direction, whether the values
 * are money or a percentage. Those choices were the source of two bugs a human
 * had to spot in the running app (markers landing on a zero-quantity day, and a
 * price series labelled as a balance), so they are asserted directly rather than
 * through the rendered chart.
 */
const chartProps = vi.fn();

vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: (props: Record<string, unknown>) => {
    chartProps(props);
    return <div data-testid="chart" />;
  },
}));

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

const prices: SecurityPricePoint[] = [
  { date: '2026-07-01', close: 100, totalReturnClose: 100 },
  { date: '2026-07-02', close: 110, totalReturnClose: 112 },
];

const steps = [{ date: '2026-07-01', quantity: 10 }];

function trade(
  overrides: Partial<SecurityHistoryTransaction> = {},
): SecurityHistoryTransaction {
  return {
    id: 'tx-1',
    transactionDate: '2026-07-01',
    accountId: 'acct-1',
    accountName: 'Brokerage',
    action: 'BUY',
    quantity: 10,
    price: 100,
    commission: 0,
    totalAmount: 1000,
    description: null,
    runningQuantityAccount: 10,
    runningQuantityAll: 10,
    ...overrides,
  } as SecurityHistoryTransaction;
}

function renderSection(mode: 'price' | 'value' | 'return' = 'price', trades = [trade()]) {
  const onModeChange = vi.fn();
  render(
    <SecurityChartSection
      security={security()}
      prices={prices}
      quantitySteps={steps}
      trades={trades}
      isLoading={false}
      mode={mode}
      onModeChange={onModeChange}
    />,
  );
  return { onModeChange, props: () => chartProps.mock.calls.at(-1)![0] };
}

describe('SecurityChartSection', () => {
  beforeEach(() => {
    chartProps.mockClear();
  });

  it('offers the three series and marks the active one', () => {
    renderSection('value');
    for (const name of ['Price', 'Investment value', 'Return']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Investment value' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('reports a series change to the caller', () => {
    const { onModeChange } = renderSection('price');
    fireEvent.click(screen.getByRole('button', { name: 'Return' }));
    expect(onModeChange).toHaveBeenCalledWith('return');
  });

  describe('the price series', () => {
    it('plots the quoted close as money, precisely', () => {
      const { props } = renderSection('price');
      expect(props().data).toEqual([
        { date: '2026-07-01', balance: 100 },
        { date: '2026-07-02', balance: 110 },
      ]);
      expect(props().valueFormat).toBe('currency');
      expect(props().precise).toBe(true);
    });
  });

  describe('the value series', () => {
    it('multiplies the close by the shares held that day', () => {
      const { props } = renderSection('value');
      expect(props().data).toEqual([
        { date: '2026-07-01', balance: 1000 },
        { date: '2026-07-02', balance: 1100 },
      ]);
    });

    it('snaps a marker forward so a first purchase is not put on a flat axis', () => {
      // Snapping backwards landed the buy on the day the position was still
      // zero, which read as the marker being missing altogether.
      expect(renderSection('value').props().markerSnap).toBe('later');
    });
  });

  describe('the return series', () => {
    it('rebases the window on its own first point, using the adjusted close', () => {
      const { props } = renderSection('return');
      // 112/100 - 1 = 12%, from the adjusted series -- not 10% from the quote,
      // which would leave out the distribution.
      expect(props().data).toEqual([
        { date: '2026-07-01', balance: 0 },
        { date: '2026-07-02', balance: 12 },
      ]);
    });

    it('writes the axis as a percentage and lets losses colour', () => {
      const { props } = renderSection('return');
      expect(props().valueFormat).toBe('percent');
      expect(props().neutralValues).toBe(false);
      expect(props().markerSnap).toBe('earlier');
    });
  });

  describe('trade markers', () => {
    it('marks buys and sells with their direction', () => {
      const { props } = renderSection('price', [
        trade(),
        trade({ id: 'tx-2', action: 'SELL', quantity: 4, transactionDate: '2026-07-02' }),
      ]);
      expect(props().markers).toEqual([
        expect.objectContaining({ date: '2026-07-01', direction: 'in' }),
        expect.objectContaining({ date: '2026-07-02', direction: 'out' }),
      ]);
    });

    it('leaves out an action that moves no shares', () => {
      // A dividend has no quantity, so there is no position change to mark.
      const { props } = renderSection('price', [
        trade({ action: 'DIVIDEND', quantity: null }),
      ]);
      expect(props().markers).toEqual([]);
    });

    it('names the account and quantity in the marker label', () => {
      const { props } = renderSection('price');
      expect(props().markers[0].label).toContain('Brokerage');
      expect(props().markers[0].label).toContain('10');
    });
  });

  it('never lets the chart call a price series a balance', () => {
    // "Min. Balance" under a price chart was a real complaint: none of these
    // three series is a balance.
    const { props } = renderSection('price');
    expect(props().summaryLabels).toEqual(
      expect.objectContaining({ lowest: expect.not.stringContaining('alance') }),
    );
    expect(props().hideExtremeFlags).toBe(true);
  });
});
