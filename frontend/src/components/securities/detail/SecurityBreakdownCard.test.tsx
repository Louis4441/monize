import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityBreakdownCard } from './SecurityBreakdownCard';
import type { Security } from '@/types/investment';

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

describe('SecurityBreakdownCard', () => {
  it('offers all three dimensions behind one tab', () => {
    render(<SecurityBreakdownCard security={security()} />);
    // Stacking three cards would make the column beside the chart several times
    // the chart's height.
    for (const name of ['Sector', 'Country', 'Asset class']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('opens on the sector split, the one the provider fills in', () => {
    render(
      <SecurityBreakdownCard
        security={security({
          sectorWeightings: [{ sector: 'Technology', weight: 0.4 }],
        })}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Sector' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('img', { name: 'Technology: 40.00%' }),
    ).toBeInTheDocument();
  });

  it('reads the sector weight off its own `sector` key', () => {
    // Sector slices are `{ sector, weight }`; the other two are `{ name, weight }`.
    render(
      <SecurityBreakdownCard
        security={security({
          sectorWeightings: [{ sector: 'Financials', weight: 0.25 }],
        })}
      />,
    );
    expect(
      screen.getByRole('img', { name: 'Financials: 25.00%' }),
    ).toBeInTheDocument();
  });

  it('switches to the country split', () => {
    render(
      <SecurityBreakdownCard
        security={security({
          sectorWeightings: [{ sector: 'Technology', weight: 0.4 }],
          countryWeightings: [{ name: 'United States', weight: 0.62 }],
        })}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Country' }));

    expect(
      screen.getByRole('img', { name: 'United States: 62.00%' }),
    ).toBeInTheDocument();
    // The sector bars are gone, not merely hidden behind them.
    expect(screen.queryByRole('img', { name: /Technology/ })).toBeNull();
  });

  it('switches to the asset-class split', () => {
    render(
      <SecurityBreakdownCard
        security={security({
          assetWeightings: [
            { name: 'US Equity', weight: 0.7 },
            { name: 'CDN Equity', weight: 0.3 },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Asset class' }));

    expect(
      screen.getByRole('img', { name: 'US Equity: 70.00%' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'CDN Equity: 30.00%' }),
    ).toBeInTheDocument();
  });

  it('says which breakdown is missing, per dimension', () => {
    render(
      <SecurityBreakdownCard
        security={security({
          sectorWeightings: [{ sector: 'Technology', weight: 1 }],
        })}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Asset class' }));
    expect(
      screen.getByText(/No asset class breakdown is stored/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Country' }));
    expect(
      screen.getByText(/No country breakdown is stored/),
    ).toBeInTheDocument();
  });

  it('shows only the selected dimension, never another one\'s bars', () => {
    const { container } = render(
      <SecurityBreakdownCard
        security={security({
          sectorWeightings: [
            { sector: 'Technology', weight: 0.5 },
            { sector: 'Financials', weight: 0.5 },
          ],
          countryWeightings: [{ name: 'United States', weight: 1 }],
          assetWeightings: [{ name: 'US Equity', weight: 1 }],
        })}
      />,
    );
    // One panel is mounted at a time, so three dimensions cannot pile up.
    expect(container.querySelectorAll('div[role="img"]')).toHaveLength(2);
  });
});
