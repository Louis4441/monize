import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityNewsTab } from './SecurityNewsTab';
import type {
  Security,
  SecurityNewsItem,
  SecurityNewsResult,
} from '@/types/investment';

const mockGetNews = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityNews: (...args: unknown[]) => mockGetNews(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

const security: Security = {
  id: 'sec-1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  securityType: 'STOCK',
  exchange: 'NASDAQ',
  currencyCode: 'USD',
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
};

function item(overrides: Partial<SecurityNewsItem> = {}): SecurityNewsItem {
  return {
    id: 'uuid-1',
    title: 'Apple says UK App Store proposal amounts to price regulation',
    publisher: 'Reuters',
    link: 'https://finance.yahoo.com/news/apple-uk.html',
    publishedAt: new Date(Date.now() - 44 * 60 * 1000).toISOString(),
    type: 'STORY',
    thumbnailUrl: '/api/v1/securities/sec-1/news/uuid-1/thumbnail',
    relatedTickers: ['AAPL'],
    ...overrides,
  };
}

function result(overrides: Partial<SecurityNewsResult> = {}): SecurityNewsResult {
  return { provider: 'yahoo', items: [item()], ...overrides };
}

async function renderTab() {
  let rendered: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(<SecurityNewsTab security={security} />);
  });
  return rendered!;
}

describe('SecurityNewsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNews.mockResolvedValue(result());
  });

  it('names what the list actually is', async () => {
    await renderTab();
    // "mentioning", not "about": the provider files a story against every
    // ticker it names, and claiming otherwise would be false.
    expect(
      screen.getByRole('heading', { name: 'News mentioning AAPL' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/files a story against every ticker/)).toBeInTheDocument();
  });

  it('gives each headline its publisher and how long ago it ran', async () => {
    await renderTab();
    expect(
      screen.getByText(/Apple says UK App Store proposal/),
    ).toBeInTheDocument();
    expect(screen.getByText('Reuters')).toBeInTheDocument();
    // Locale-aware, via Intl.RelativeTimeFormat.
    expect(screen.getByText(/44 minutes ago/)).toBeInTheDocument();
  });

  it('opens the story in a new tab without leaking the referrer', async () => {
    await renderTab();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute(
      'href',
      'https://finance.yahoo.com/news/apple-uk.html',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  describe('thumbnails', () => {
    it('loads the image from our own API, not the publisher', async () => {
      await renderTab();
      const image = screen.getByRole('presentation', { hidden: true });
      expect(image).toHaveAttribute(
        'src',
        '/api/v1/securities/sec-1/news/uuid-1/thumbnail',
      );
      // The CSP is `img-src 'self' data: blob:`; a CDN URL would be blocked,
      // and it would tell the publisher who is reading.
      expect(image.getAttribute('src')).not.toContain('yimg');
    });

    it('renders a headline that has no image', async () => {
      mockGetNews.mockResolvedValue(
        result({ items: [item({ thumbnailUrl: null })] }),
      );
      await renderTab();
      expect(screen.queryByRole('presentation', { hidden: true })).toBeNull();
      expect(screen.getByText(/Apple says UK App Store/)).toBeInTheDocument();
    });
  });

  it('names the other tickers on a story that is not really about this one', async () => {
    mockGetNews.mockResolvedValue(
      result({
        items: [
          item({
            title: 'Berkshire slips despite UBS raising target',
            relatedTickers: ['BRK-B', 'AAPL', 'UBS'],
          }),
        ],
      }),
    );
    await renderTab();
    // Its own symbol is the one the reader is looking at; the others are what
    // say "this is a Berkshire story".
    expect(screen.getByText('Also mentions BRK-B, UBS')).toBeInTheDocument();
  });

  it('marks a video so it is not taken for an article', async () => {
    mockGetNews.mockResolvedValue(
      result({ items: [item({ type: 'VIDEO' })] }),
    );
    await renderTab();
    expect(screen.getByLabelText('Video')).toBeInTheDocument();
  });

  describe('nothing to show', () => {
    it('says the provider supplies no news, rather than showing an empty feed', async () => {
      mockGetNews.mockResolvedValue({ provider: null, items: [] });
      await renderTab();
      // "Nothing published" and "we cannot ask" are different statements.
      expect(
        screen.getByText(/supplies no news/),
      ).toBeInTheDocument();
      expect(screen.queryByText('No headlines right now')).toBeNull();
    });

    it('says nothing was published when the provider simply had none', async () => {
      mockGetNews.mockResolvedValue({ provider: 'yahoo', items: [] });
      await renderTab();
      expect(screen.getByText('No headlines right now')).toBeInTheDocument();
    });
  });

  it('reports a failure without breaking the tab', async () => {
    mockGetNews.mockRejectedValue(new Error('boom'));
    await renderTab();
    expect(
      screen.getByText('Could not load the news for this security'),
    ).toBeInTheDocument();
    // The heading survives, so the reader knows which tab failed.
    expect(
      screen.getByRole('heading', { name: 'News mentioning AAPL' }),
    ).toBeInTheDocument();
  });
});
