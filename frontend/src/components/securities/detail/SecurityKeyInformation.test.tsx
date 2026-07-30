import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityKeyInformation } from './SecurityKeyInformation';
import type { Security } from '@/types/investment';
import type { SecurityPricePoint } from '@/lib/security-detail';

/** The user's own default provider, which a security without one inherits. */
const preferences = { current: { defaultQuoteProvider: 'msn' } as { defaultQuoteProvider: string } | null };
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: preferences.current }),
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

/** Two points that agree: an adjusted series exists and nothing was paid out. */
const accumulating: SecurityPricePoint[] = [
  { date: '2024-01-01', close: 100, totalReturnClose: 100 },
  { date: '2025-01-01', close: 120, totalReturnClose: 120 },
];

/** No adjusted series at all, as MSN supplies. */
const noAdjustedSeries: SecurityPricePoint[] = [
  { date: '2024-01-01', close: 100 },
  { date: '2025-01-01', close: 120 },
];

describe('SecurityKeyInformation', () => {
  beforeEach(() => {
    preferences.current = { defaultQuoteProvider: 'msn' };
  });

  it('drops the rows a thinly-filled security has no value for', () => {
    // A column of dashes says nothing; `KeyValueList` omits an empty row, so this
    // has to stay true as rows are added.
    render(
      <SecurityKeyInformation
        security={security({ exchange: null, sector: null, industry: null })}
        latestPrice={null}
        prices={[]}
      />,
    );

    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.queryByText('Exchange')).not.toBeInTheDocument();
    expect(screen.queryByText('Sector')).not.toBeInTheDocument();
    expect(screen.queryByText('Industry')).not.toBeInTheDocument();
    expect(screen.queryByText('Last price')).not.toBeInTheDocument();
  });

  it('states the distribution behaviour it can read off the price history', () => {
    render(
      <SecurityKeyInformation
        security={security()}
        latestPrice={null}
        prices={accumulating}
      />,
    );

    expect(screen.getByText('Distributions')).toBeInTheDocument();
    // Worded as observed from data, not declared by the issuer.
    expect(screen.getByText('None (accumulating)')).toBeInTheDocument();
  });

  it('drops the distribution row rather than guessing without an adjusted series', () => {
    render(
      <SecurityKeyInformation
        security={security()}
        latestPrice={null}
        prices={noAdjustedSeries}
      />,
    );

    expect(screen.queryByText('Distributions')).not.toBeInTheDocument();
  });

  it('names the effective provider, never a blank row', () => {
    // A security with no provider of its own uses the user's default, so the
    // answer here is what will actually be asked for a quote.
    render(
      <SecurityKeyInformation
        security={security({ quoteProvider: null })}
        latestPrice={null}
        prices={[]}
      />,
    );

    expect(screen.getByText('Provider')).toBeInTheDocument();
    expect(screen.getByText('MSN')).toBeInTheDocument();
  });

  it('falls back to Yahoo when the user has no default either', () => {
    preferences.current = null;
    render(
      <SecurityKeyInformation
        security={security({ quoteProvider: null })}
        latestPrice={null}
        prices={[]}
      />,
    );

    expect(screen.getByText('Yahoo')).toBeInTheDocument();
  });

  it('dates the last price, because a stale quote reads as a current one', () => {
    render(
      <SecurityKeyInformation
        security={security()}
        latestPrice={{ price: 123.45, priceDate: '2026-07-28' }}
        prices={[]}
      />,
    );

    expect(screen.getByText('Last price')).toBeInTheDocument();
    expect(screen.getByText(/123\.45/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });
});
