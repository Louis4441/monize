import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { ShareInboxNotice } from './ShareInboxNotice';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@/types/auth';

// The banner is the durable way back to a share whose redirect did not survive
// (an OIDC round trip that drops returnTo, or the user opening Monize from the
// launcher). Without it those files sit on the device until they expire with
// nothing on any screen pointing at them.

const pathname = { value: '/dashboard' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname.value,
  useSearchParams: () => new URLSearchParams(),
}));

const mocks = vi.hoisted(() => ({
  listSharedBundles: vi.fn(),
  purgeExpiredSharedBundles: vi.fn(),
}));

vi.mock('@/lib/share-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-inbox')>()),
  listSharedBundles: mocks.listSharedBundles,
  purgeExpiredSharedBundles: mocks.purgeExpiredSharedBundles,
}));

function bundleIndex(id: string, acceptedFiles: number, refusedFiles = 0) {
  const files = [
    ...Array.from({ length: acceptedFiles }, (_, i) => ({
      name: `ok-${i}.png`,
      type: 'image/png',
      size: 1,
      kind: 'attachment' as const,
      key: `k-${i}`,
    })),
    ...Array.from({ length: refusedFiles }, (_, i) => ({
      name: `bad-${i}.zip`,
      type: '',
      size: 1,
      kind: null,
      reason: 'unsupported' as const,
    })),
  ];
  return { id, createdAt: Date.now(), files };
}

/**
 * A bundle belongs to the first authenticated reader that observes it, and this
 * banner IS an observation -- so it needs a named reader, not merely an
 * authenticated one.
 */
const VIEWER_ID = 'user-1';

const reader = (id: string) => ({ id, email: 'reader@monize.test' }) as User;

async function renderNotice() {
  await act(async () => {
    render(<ShareInboxNotice />);
  });
}

describe('ShareInboxNotice', () => {
  beforeEach(() => {
    pathname.value = '/dashboard';
    mocks.purgeExpiredSharedBundles.mockResolvedValue(undefined);
    mocks.listSharedBundles.mockResolvedValue([]);
    act(() => {
      useAuthStore.setState({ isAuthenticated: true, user: reader(VIEWER_ID) });
    });
  });

  afterEach(() => {
    cleanup();
    act(() => {
      useAuthStore.getState().logout();
    });
    vi.clearAllMocks();
  });

  it('offers the newest waiting share, and purges before reading', async () => {
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('newest', 2)]);

    await renderNotice();

    expect(await screen.findByText(/2 files were shared with monize/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review/i })).toHaveAttribute(
      'href',
      '/share?id=newest',
    );
    expect(mocks.purgeExpiredSharedBundles).toHaveBeenCalled();
  });

  it('counts one file in the singular', async () => {
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('one', 1)]);

    await renderNotice();

    expect(await screen.findByText(/1 file was shared with monize/i)).toBeInTheDocument();
  });

  // A share whose every file was refused has nothing to offer on the review
  // screen, so interrupting the user with it would be noise.
  it('stays silent when no file in the share is usable', async () => {
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('refused', 0, 3)]);

    await renderNotice();

    await waitFor(() => expect(mocks.listSharedBundles).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /review/i })).not.toBeInTheDocument();
  });

  it('counts only the usable files in a partly refused share', async () => {
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('mixed', 1, 2)]);

    await renderNotice();

    expect(await screen.findByText(/1 file was shared with monize/i)).toBeInTheDocument();
  });

  it('stays silent with nothing waiting', async () => {
    await renderNotice();

    await waitFor(() => expect(mocks.listSharedBundles).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /review/i })).not.toBeInTheDocument();
  });

  // The review screen is already showing the share; a banner over it would be
  // pointing at the page the user is on.
  it('never draws over the review screen itself', async () => {
    pathname.value = '/share';
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('newest', 1)]);

    await renderNotice();

    expect(screen.queryByRole('link', { name: /review/i })).not.toBeInTheDocument();
    // It does not even read the stash there.
    expect(mocks.listSharedBundles).not.toHaveBeenCalled();
  });

  it('reads nothing while signed out', async () => {
    act(() => {
      useAuthStore.setState({ isAuthenticated: false, user: null });
    });
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('newest', 1)]);

    await renderNotice();

    expect(mocks.listSharedBundles).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /review/i })).not.toBeInTheDocument();
  });

  // Listing a bundle CLAIMS it for the reader, so an unnamed one must not list:
  // the notice is the surface that would otherwise stamp a share with whoever
  // the app is still resolving. `isAuthenticated` rehydrates from localStorage
  // before the profile request lands, so this state is the ordinary first paint
  // after a reload, not a corner case.
  it('reads nothing while the reader is still unnamed', async () => {
    act(() => {
      useAuthStore.setState({ isAuthenticated: true, user: null });
    });
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('newest', 1)]);

    await renderNotice();

    expect(mocks.listSharedBundles).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /review/i })).not.toBeInTheDocument();

    // Named, it reads on that account's behalf and offers the share.
    await act(async () => {
      useAuthStore.setState({ user: reader(VIEWER_ID) });
    });

    expect(await screen.findByRole('link', { name: /review/i })).toBeInTheDocument();
    expect(mocks.listSharedBundles).toHaveBeenCalledWith(VIEWER_ID);
  });

  it('lists on behalf of the signed-in reader', async () => {
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('newest', 1)]);

    await renderNotice();

    await waitFor(() =>
      expect(mocks.listSharedBundles).toHaveBeenCalledWith(VIEWER_ID),
    );
  });

  it('can be dismissed', async () => {
    mocks.listSharedBundles.mockResolvedValue([bundleIndex('newest', 1)]);

    await renderNotice();

    const dismiss = await screen.findByRole('button', { name: /dismiss/i });
    await act(async () => {
      dismiss.click();
    });

    expect(screen.queryByRole('link', { name: /review/i })).not.toBeInTheDocument();
  });
});
