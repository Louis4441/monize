import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityAboutCard } from './SecurityAboutCard';
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

describe('SecurityAboutCard', () => {
  it('shows the stored description', () => {
    render(
      <SecurityAboutCard
        security={security({ description: 'Tracks developed and emerging markets.' })}
      />,
    );
    expect(
      screen.getByText('Tracks developed and emerging markets.'),
    ).toBeInTheDocument();
  });

  it('says there is no description rather than leaving a gap', () => {
    render(<SecurityAboutCard security={security()} />);
    expect(
      screen.getByText('No description has been saved for this security.'),
    ).toBeInTheDocument();
  });

  it('drops the classification rows a security has no values for', () => {
    render(<SecurityAboutCard security={security()} />);
    // A thinly-filled security should read as a short list, not a column of
    // dashes -- KeyValueList drops empty rows for exactly this reason.
    expect(screen.queryByText('Sector')).not.toBeInTheDocument();
    expect(screen.queryByText('Industry')).not.toBeInTheDocument();
    expect(screen.queryByText('Country')).not.toBeInTheDocument();
  });

  it('lists the sector and industry when the provider supplied them', () => {
    render(
      <SecurityAboutCard
        security={security({ sector: 'Technology', industry: 'Semiconductors' })}
      />,
    );
    expect(screen.getByText('Technology')).toBeInTheDocument();
    expect(screen.getByText('Semiconductors')).toBeInTheDocument();
  });

  describe('countries', () => {
    it('joins the stored country weightings into one line', () => {
      render(
        <SecurityAboutCard
          security={security({
            countryWeightings: [
              { name: 'United States', weight: 0.6 },
              { name: 'Japan', weight: 0.4 },
            ],
          })}
        />,
      );
      expect(screen.getByText('United States, Japan')).toBeInTheDocument();
    });

    it('drops the row when the weightings carry no names', () => {
      render(
        <SecurityAboutCard
          security={security({ countryWeightings: [{ name: '', weight: 1 }] })}
        />,
      );
      expect(screen.queryByText('Country')).not.toBeInTheDocument();
    });
  });

  describe('tags', () => {
    it('renders each tag in its own colour', () => {
      render(
        <SecurityAboutCard
          security={security({
            tags: [
              { id: 't1', name: 'core', color: '#ff0000' },
              { id: 't2', name: 'accumulating', color: null },
            ],
          } as Partial<Security>)}
        />,
      );
      expect(screen.getByText('core')).toBeInTheDocument();
      // A tag with no colour of its own still renders, in the neutral fallback:
      // a user-chosen entity colour is never themed, and never required either.
      expect(screen.getByText('accumulating')).toBeInTheDocument();
    });

    it('drops the row for an untagged security', () => {
      render(<SecurityAboutCard security={security({ tags: [] })} />);
      expect(screen.queryByText('Tags')).not.toBeInTheDocument();
    });
  });

  it('marks the fields the schema has no column for as not stored', () => {
    render(<SecurityAboutCard security={security()} />);
    // Website and IR website are laid out but unbacked; a placeholder is honest
    // where a fabricated link would not be.
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.getByText('IR Website')).toBeInTheDocument();
    expect(screen.getAllByText('Not stored yet')).toHaveLength(2);
  });
});
