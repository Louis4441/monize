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
    website: null,
    irWebsite: null,
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

  describe('the two addresses', () => {
    it('links to each one, showing the host', () => {
      render(
        <SecurityAboutCard
          security={security({
            website: 'https://www.apple.com',
            irWebsite: 'https://investor.apple.com',
          })}
        />,
      );

      const site = screen.getByRole('link', { name: 'apple.com' });
      expect(site).toHaveAttribute('href', 'https://www.apple.com');
      // Opens away from the app, and the destination has no business learning
      // which page the reader came from.
      expect(site).toHaveAttribute('target', '_blank');
      expect(site).toHaveAttribute('rel', 'noopener noreferrer');
      expect(
        screen.getByRole('link', { name: 'investor.apple.com' }),
      ).toBeInTheDocument();
    });

    it('drops the row when an address is not stored', () => {
      // These used to read "Not stored yet" because there was no column. There
      // is one now, so an unset field behaves like every other empty row.
      render(<SecurityAboutCard security={security()} />);
      expect(screen.queryByText('Website')).not.toBeInTheDocument();
      expect(screen.queryByText('IR Website')).not.toBeInTheDocument();
    });

    it('refuses to build a link from an address that is not http(s)', () => {
      // The value reaches here from the database; the backend normalises what it
      // stores, but a link built from an unchecked string is a link that can run
      // something.
      render(
        <SecurityAboutCard
          security={security({ website: 'javascript:alert(1)' })}
        />,
      );
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByText('Website')).not.toBeInTheDocument();
    });

    it('shows one address without implying the other exists', () => {
      render(
        <SecurityAboutCard security={security({ website: 'https://vanguard.co.uk' })} />,
      );
      expect(screen.getByRole('link', { name: 'vanguard.co.uk' })).toBeInTheDocument();
      expect(screen.queryByText('IR Website')).not.toBeInTheDocument();
    });
  });
});
