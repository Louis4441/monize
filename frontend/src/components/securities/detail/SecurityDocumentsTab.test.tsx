import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityDocumentsTab } from './SecurityDocumentsTab';
import type { Security, SecurityDocument } from '@/types/investment';

const mockGetDocuments = vi.fn();
const mockCreateDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockDeleteDocument = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityDocuments: (...args: unknown[]) => mockGetDocuments(...args),
    createSecurityDocument: (...args: unknown[]) => mockCreateDocument(...args),
    updateSecurityDocument: (...args: unknown[]) => mockUpdateDocument(...args),
    deleteSecurityDocument: (...args: unknown[]) => mockDeleteDocument(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

const security: Security = {
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
};

function document(overrides: Partial<SecurityDocument> = {}): SecurityDocument {
  return {
    id: 'doc-1',
    securityId: 'sec-1',
    documentType: 'FACTSHEET',
    name: 'Factsheet June 2026',
    documentDate: '2026-06-30',
    url: 'https://www.ishares.com/de/factsheet.pdf',
    notes: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

async function renderTab() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<SecurityDocumentsTab security={security} />);
  });
  return result!;
}

describe('SecurityDocumentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDocuments.mockResolvedValue([]);
    mockCreateDocument.mockResolvedValue(document());
    mockUpdateDocument.mockResolvedValue(document());
    mockDeleteDocument.mockResolvedValue(undefined);
  });

  describe('the empty state', () => {
    it('says what documents are for and offers the first one', async () => {
      await renderTab();
      // Not an empty table with headers over nothing.
      expect(screen.getByText('No documents yet')).toBeInTheDocument();
      expect(screen.getByText(/factsheet, its KIID/)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Add the first document' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('leaves out the header button, which would be the same action twice', async () => {
      await renderTab();
      expect(
        screen.queryByRole('button', { name: 'Add document' }),
      ).not.toBeInTheDocument();
    });

    it('opens the form from the empty state', async () => {
      await renderTab();
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Add the first document' }),
        );
      });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('the list', () => {
    it('gives each document its type, name, date and address', async () => {
      mockGetDocuments.mockResolvedValue([document()]);
      await renderTab();

      expect(screen.getByText('Factsheet')).toBeInTheDocument();
      expect(screen.getByText('Factsheet June 2026')).toBeInTheDocument();
      // The host, not the whole URL: a factsheet link is a couple of hundred
      // characters and none of them say as much as the domain does.
      expect(screen.getByText('ishares.com')).toBeInTheDocument();
    });

    it('says a document has no date rather than leaving the cell blank', async () => {
      mockGetDocuments.mockResolvedValue([document({ documentDate: null })]);
      await renderTab();
      expect(screen.getByText('No date')).toBeInTheDocument();
    });

    it('shows a note under the name when there is one', async () => {
      mockGetDocuments.mockResolvedValue([
        document({ notes: 'German share class' }),
      ]);
      await renderTab();
      expect(screen.getByText('German share class')).toBeInTheDocument();
    });

    it('offers the Add button in the header once there are rows', async () => {
      mockGetDocuments.mockResolvedValue([document()]);
      await renderTab();
      expect(
        screen.getByRole('button', { name: 'Add document' }),
      ).toBeInTheDocument();
    });
  });

  describe('opening a document', () => {
    it('links to the address in a new tab, without leaking the referrer', async () => {
      mockGetDocuments.mockResolvedValue([document()]);
      await renderTab();

      const link = screen.getByRole('link', {
        name: 'Open Factsheet June 2026 in a new tab',
      });
      expect(link).toHaveAttribute(
        'href',
        'https://www.ishares.com/de/factsheet.pdf',
      );
      expect(link).toHaveAttribute('target', '_blank');
      // The destination has no business learning which page the reader came from.
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('puts the whole address on the link, where the column shows the host', async () => {
      mockGetDocuments.mockResolvedValue([document()]);
      await renderTab();
      expect(
        screen.getByRole('link', { name: /Open Factsheet/ }),
      ).toHaveAttribute('title', 'https://www.ishares.com/de/factsheet.pdf');
    });
  });

  describe('deleting', () => {
    it('asks first, and says the document itself is untouched', async () => {
      mockGetDocuments.mockResolvedValue([document()]);
      await renderTab();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      });
      expect(screen.getByText('Delete document?')).toBeInTheDocument();
      expect(
        screen.getByText(/The document itself is not touched/),
      ).toBeInTheDocument();
      expect(mockDeleteDocument).not.toHaveBeenCalled();
    });

    it('deletes once confirmed and reloads the list', async () => {
      mockGetDocuments.mockResolvedValue([document()]);
      await renderTab();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      });
      await act(async () => {
        fireEvent.click(
          screen.getAllByRole('button', { name: 'Delete' }).at(-1)!,
        );
      });
      await waitFor(() =>
        expect(mockDeleteDocument).toHaveBeenCalledWith('sec-1', 'doc-1'),
      );
      expect(mockGetDocuments).toHaveBeenCalledTimes(2);
    });
  });

  it('reports a load failure without claiming there are no documents', async () => {
    mockGetDocuments.mockRejectedValue(new Error('boom'));
    await renderTab();

    expect(
      screen.getByText('Could not load the documents for this security'),
    ).toBeInTheDocument();
    // A failed read leaves the list empty too, and "No documents yet" under the
    // error would assert there are none when in fact none could be read.
    expect(screen.queryByText('No documents yet')).not.toBeInTheDocument();
    // Still a way forward rather than a dead panel.
    expect(
      screen.getByRole('button', { name: 'Add document' }),
    ).toBeInTheDocument();
  });
});
