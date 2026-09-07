import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test/render';
import SharePage from './page';
import type { SharedBundle, SharedBundleItem } from '@/lib/share-inbox';

// The review screen is where the plan's second requirement lives: a share
// always lands somewhere that explains itself, and nothing is imported or
// attached without the user pressing a button. Every state below is one a user
// can reach, so each gets a case -- including the three that carry no bundle
// at all, which is what keeps a share off a browser error page.

// Not spread from the original: `next/navigation`'s real `useRouter` throws
// outside an app-router tree, so this replaces the module the way setup.ts does
// and adds the search params this screen reads.
const searchParams = { value: new URLSearchParams() };
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/share',
  useSearchParams: () => searchParams.value,
}));

const mocks = vi.hoisted(() => ({
  readSharedBundle: vi.fn(),
  listSharedBundles: vi.fn(),
  discardSharedBundle: vi.fn(),
  isShareInboxSupported: vi.fn(() => true),
}));

vi.mock('@/lib/share-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-inbox')>()),
  readSharedBundle: mocks.readSharedBundle,
  listSharedBundles: mocks.listSharedBundles,
  discardSharedBundle: mocks.discardSharedBundle,
  isShareInboxSupported: mocks.isShareInboxSupported,
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The form is a heavy dynamic import with its own data loading; this screen's
// contract is only that it opens with the shared files staged.
const transactionForm = vi.hoisted(() => vi.fn());
vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: (props: { initialStagedFiles?: File[] }) => {
    transactionForm(props);
    return <div data-testid="transaction-form" />;
  },
}));

function item(
  name: string,
  type: string,
  overrides: Partial<SharedBundleItem> = {},
): SharedBundleItem {
  const hasFile = overrides.file !== null;
  return {
    entry: { name, type, size: 10, kind: null, key: 'k' },
    file: hasFile ? new File(['x'], name, { type }) : null,
    missing: false,
    ...overrides,
  };
}

function bundle(items: SharedBundleItem[], overrides: Partial<SharedBundle> = {}): SharedBundle {
  return {
    index: {
      id: 'bundle-1',
      createdAt: Date.now(),
      files: items.map((entryItem) => entryItem.entry),
    },
    items,
    files: items
      .map((entryItem) => entryItem.file)
      .filter((file): file is File => file !== null),
    expired: false,
    ...overrides,
  };
}

async function renderPage() {
  await act(async () => {
    render(<SharePage />);
  });
}

describe('share review screen', () => {
  beforeEach(() => {
    searchParams.value = new URLSearchParams('id=bundle-1');
    mocks.isShareInboxSupported.mockReturnValue(true);
    mocks.listSharedBundles.mockResolvedValue([]);
    mocks.discardSharedBundle.mockResolvedValue(undefined);
    mocks.readSharedBundle.mockResolvedValue(null);
    transactionForm.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers a new transaction for a share of receipts, and stages the files', async () => {
    const items = [item('receipt.jpg', 'image/jpeg'), item('bill.pdf', 'application/pdf')];
    mocks.readSharedBundle.mockResolvedValue(bundle(items));

    await renderPage();

    expect(await screen.findByText('receipt.jpg')).toBeInTheDocument();
    expect(screen.getByText('bill.pdf')).toBeInTheDocument();
    const attach = screen.getByRole('button', { name: /attach to a new transaction/i });
    expect(attach).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /import as a statement/i }),
    ).not.toBeInTheDocument();

    // Nothing has been created just by landing here.
    expect(transactionForm).not.toHaveBeenCalled();

    await act(async () => {
      attach.click();
    });

    await waitFor(() => expect(transactionForm).toHaveBeenCalled());
    expect(transactionForm.mock.calls[0][0].initialStagedFiles).toHaveLength(2);
  });

  it('offers the import wizard for a share of statements', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('january.csv', 'text/csv')]),
    );

    await renderPage();

    expect(
      await screen.findByRole('button', { name: /import as a statement/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /attach to a new transaction/i }),
    ).not.toBeInTheDocument();
  });

  // Receipts and statements go to different places, so a share holding both
  // gets neither destination rather than a guess about which was meant.
  it('offers no destination for a mixed share, and says why', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg'), item('january.csv', 'text/csv')]),
    );

    await renderPage();

    expect(
      await screen.findByText(/receipts and statements need separate shares/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /attach to a new transaction/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /import as a statement/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
  });

  it('lists a refused file with its reason and offers nothing to do with it', async () => {
    const refused = item('profile.mny', '', {
      entry: {
        name: 'profile.mny',
        type: '',
        size: 999,
        kind: null,
        reason: 'unsupported',
      },
      file: null,
    });
    mocks.readSharedBundle.mockResolvedValue(bundle([refused]));

    await renderPage();

    expect(await screen.findByText('profile.mny')).toBeInTheDocument();
    expect(screen.getByText(/cannot use this kind of file/i)).toBeInTheDocument();
    expect(
      screen.getByText(/could not use any of these files/i),
    ).toBeInTheDocument();
  });

  // An accepted file whose bytes were evicted is unavailable, not refused, and
  // is never silently dropped from a list that would then look complete.
  it('marks an accepted file whose bytes are gone as unavailable', async () => {
    const evicted = item('gone.png', 'image/png', { file: null, missing: true });
    mocks.readSharedBundle.mockResolvedValue(bundle([evicted]));

    await renderPage();

    expect(await screen.findByText('gone.png')).toBeInTheDocument();
    expect(screen.getByText(/no longer on this device/i)).toBeInTheDocument();
  });

  it('explains an expired bundle rather than showing it as empty', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg')], { expired: true }),
    );

    await renderPage();

    expect(await screen.findByText(/have expired/i)).toBeInTheDocument();
  });

  it('explains a share the worker never caught', async () => {
    searchParams.value = new URLSearchParams('missed=1');

    await renderPage();

    expect(await screen.findByText(/did not reach monize/i)).toBeInTheDocument();
    // Nothing is read from the stash on this path: there is nothing in it.
    expect(mocks.readSharedBundle).not.toHaveBeenCalled();
  });

  it('explains a share the worker could not keep', async () => {
    searchParams.value = new URLSearchParams('error=stash');

    await renderPage();

    expect(
      await screen.findByText(/could not hold on to those files/i),
    ).toBeInTheDocument();
  });

  it('explains a browser with no Cache API instead of failing', async () => {
    mocks.isShareInboxSupported.mockReturnValue(false);

    await renderPage();

    expect(
      await screen.findByText(/cannot receive shared files/i),
    ).toBeInTheDocument();
  });

  it('reports an unknown id as nothing to review', async () => {
    mocks.readSharedBundle.mockResolvedValue(null);

    await renderPage();

    expect(await screen.findByText(/nothing here to review/i)).toBeInTheDocument();
  });

  // Reached from the launcher rather than from the redirect: the newest live
  // bundle is the one the user would have been sent to.
  it('falls back to the newest bundle when no id is given', async () => {
    searchParams.value = new URLSearchParams();
    mocks.listSharedBundles.mockResolvedValue([
      { id: 'newest', createdAt: Date.now(), files: [] },
    ]);
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg')]),
    );

    await renderPage();

    await waitFor(() =>
      expect(mocks.readSharedBundle).toHaveBeenCalledWith('newest'),
    );
  });

  it('discards only after the confirmation is accepted', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg')]),
    );

    await renderPage();

    const discard = await screen.findByRole('button', { name: /^discard$/i });
    await act(async () => {
      discard.click();
    });
    expect(mocks.discardSharedBundle).not.toHaveBeenCalled();

    // Scoped to the dialog: the trigger button is still in the DOM behind it.
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      within(dialog).getByRole('button', { name: /^discard$/i }).click();
    });

    await waitFor(() =>
      expect(mocks.discardSharedBundle).toHaveBeenCalledWith('bundle-1'),
    );
  });
});
