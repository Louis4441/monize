import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeLocationMap } from './PayeeLocationMap';
import type { Payee } from '@/types/payee';

const refreshGeocode = vi.fn();

vi.mock('@/lib/payees', async () => {
  const actual = await vi.importActual<typeof import('@/lib/payees')>(
    '@/lib/payees',
  );
  return {
    ...actual,
    payeesApi: { refreshGeocode: (...args: unknown[]) => refreshGeocode(...args) },
  };
});

function payeeFixture(overrides: Partial<Payee> = {}): Payee {
  return {
    id: 'payee-1',
    userId: 'user-1',
    name: 'Starbucks',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    website: null,
    hasLogo: false,
    logoFetchedAt: null,
    address: null,
    email: null,
    phone: null,
    latitude: null,
    longitude: null,
    geocodedAt: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const located = {
  address: '1912 Pike Pl, Seattle',
  latitude: 47.609722,
  longitude: -122.342201,
};

describe('PayeeLocationMap', () => {
  beforeEach(() => {
    refreshGeocode.mockReset().mockResolvedValue(payeeFixture(located));
  });

  it('renders nothing when the payee has no address', () => {
    const { container } = render(
      <PayeeLocationMap payee={payeeFixture()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  describe('with a located address', () => {
    it('draws a grid of tiles served from our own backend', () => {
      render(<PayeeLocationMap payee={payeeFixture(located)} />);

      const tiles = screen
        .getAllByRole('presentation', { hidden: true })
        .filter((el) => el.tagName === 'IMG');
      expect(tiles).toHaveLength(9);
      // Never a third-party tile host: the CSP blocks those, and the whole
      // point of the proxy is that the browser contacts nobody else.
      for (const tile of tiles) {
        expect(tile.getAttribute('src')).toMatch(/^\/api\/v1\/map-tiles\/16\//);
      }
    });

    it('links the map to the viewer default maps application', () => {
      render(<PayeeLocationMap payee={payeeFixture(located)} />);

      const link = screen.getByRole('link', {
        name: 'Open this address in your maps app',
      });
      expect(link.getAttribute('href')).toContain('47.609722');
    });

    it('credits OpenStreetMap, which its tile licence requires', () => {
      render(<PayeeLocationMap payee={payeeFixture(located)} />);

      const attribution = screen.getByRole('link', {
        name: /OpenStreetMap contributors/,
      });
      expect(attribution).toHaveAttribute(
        'href',
        'https://www.openstreetmap.org/copyright',
      );
    });

    it('keeps the attribution out of the map link, since a nested link is invalid', () => {
      render(<PayeeLocationMap payee={payeeFixture(located)} />);

      const mapLink = screen.getByRole('link', {
        name: 'Open this address in your maps app',
      });
      const attribution = screen.getByRole('link', {
        name: /OpenStreetMap contributors/,
      });
      expect(mapLink.contains(attribution)).toBe(false);
    });

    it('offers no retry, because there is nothing to retry', () => {
      render(<PayeeLocationMap payee={payeeFixture(located)} />);

      expect(
        screen.queryByRole('button', { name: 'Retry location lookup' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('with an address the lookup could not locate', () => {
    const unlocated = {
      address: '1912 Pike Pl, Seattle',
      geocodedAt: '2026-01-02T00:00:00Z',
    };

    it('says so rather than rendering a blank frame', () => {
      render(<PayeeLocationMap payee={payeeFixture(unlocated)} />);

      expect(
        screen.getByText('This address could not be found on the map.'),
      ).toBeInTheDocument();
    });

    it('offers a retry, because a failed lookup is the one case retrying helps', () => {
      render(<PayeeLocationMap payee={payeeFixture(unlocated)} />);

      expect(
        screen.getByRole('button', { name: 'Retry location lookup' }),
      ).toBeInTheDocument();
    });

    it('re-runs the lookup and tells the page to reload on success', async () => {
      const onRefreshed = vi.fn();
      render(
        <PayeeLocationMap
          payee={payeeFixture(unlocated)}
          onRefreshed={onRefreshed}
        />,
      );

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Retry location lookup' }),
        );
      });

      expect(refreshGeocode).toHaveBeenCalledWith('payee-1');
      expect(onRefreshed).toHaveBeenCalled();
    });

    it('does not claim success when the retry fails', async () => {
      refreshGeocode.mockRejectedValue(new Error('offline'));
      const onRefreshed = vi.fn();
      render(
        <PayeeLocationMap
          payee={payeeFixture(unlocated)}
          onRefreshed={onRefreshed}
        />,
      );

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Retry location lookup' }),
        );
      });

      expect(onRefreshed).not.toHaveBeenCalled();
      // Still offered, so the user can try again.
      expect(
        screen.getByRole('button', { name: 'Retry location lookup' }),
      ).toBeInTheDocument();
    });
  });

  it('offers no retry before any lookup has run', () => {
    // geocodedAt null means nothing was attempted -- for instance the address
    // was only just typed -- so a retry would be retrying nothing.
    render(
      <PayeeLocationMap
        payee={payeeFixture({ address: '1912 Pike Pl', geocodedAt: null })}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Retry location lookup' }),
    ).not.toBeInTheDocument();
  });
});
