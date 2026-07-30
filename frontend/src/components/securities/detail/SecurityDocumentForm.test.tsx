import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityDocumentForm } from './SecurityDocumentForm';
import type { SecurityDocument } from '@/types/investment';

function existingDocument(
  overrides: Partial<SecurityDocument> = {},
): SecurityDocument {
  return {
    id: 'doc-1',
    securityId: 'sec-1',
    documentType: 'FACTSHEET',
    name: 'Factsheet 2025',
    documentDate: '2025-06-30',
    url: 'https://ishares.com/factsheet.pdf',
    notes: 'Quarterly',
    createdAt: '2025-07-01T00:00:00.000Z',
    updatedAt: '2025-07-01T00:00:00.000Z',
    ...overrides,
  } as SecurityDocument;
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
  });
}

describe('SecurityDocumentForm', () => {
  it('requires a name and an address before it will submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <SecurityDocumentForm onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    await submit();

    await waitFor(() => {
      expect(screen.getByText('Give the document a name')).toBeInTheDocument();
    });
    expect(screen.getByText('An address is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects an address that is not http or https', async () => {
    // Client-side twin of the backend's protocol allowlist: the server is the
    // authority, this just catches a typo before a round trip. A bare host is the
    // usual mistake, and it would render an Open action that goes nowhere.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SecurityDocumentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fill('Name', 'Factsheet');
    fill('Address', 'ishares.com/factsheet.pdf');
    await submit();

    await waitFor(() => {
      expect(
        screen.getByText('The address must start with http:// or https://'),
      ).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims what it sends, and omits empty optional fields on create', async () => {
    // On create an absent field means "leave it null", so it is left out of the
    // payload entirely rather than sent as an empty string.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SecurityDocumentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fill('Name', '  Factsheet 2025  ');
    fill('Address', '  https://ishares.com/factsheet.pdf  ');
    await submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      documentType: 'OTHER',
      name: 'Factsheet 2025',
      url: 'https://ishares.com/factsheet.pdf',
      documentDate: undefined,
      notes: undefined,
    });
  });

  it('sends an explicit null when an edit clears a date or a note', async () => {
    // Regression guard for the reason `cleared` exists: the server assigns only
    // what the request carries, so omitting a cleared field left the old value in
    // place and clearing a date was impossible from the UI.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <SecurityDocumentForm
        document={existingDocument()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fill('Document date', '');
    fill('Notes', '');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ documentDate: null, notes: null }),
    );
  });

  it('keeps the form open when the caller rejects', async () => {
    // The caller surfaces its own error; rethrowing here would leave
    // react-hook-form with an unhandled rejection.
    const onSubmit = vi.fn().mockRejectedValue(new Error('taken'));
    render(<SecurityDocumentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fill('Name', 'Factsheet');
    fill('Address', 'https://ishares.com/f.pdf');
    await submit();
    await act(async () => {});

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('offers Save rather than Add when editing', async () => {
    render(
      <SecurityDocumentForm
        document={existingDocument()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Save document' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add document' }),
    ).not.toBeInTheDocument();
  });
});
