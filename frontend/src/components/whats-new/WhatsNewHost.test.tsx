import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { WhatsNewHost } from './WhatsNewHost';
import { useAuthStore } from '@/store/authStore';
import { useTourStore } from '@/store/tourStore';
import {
  useWhatsNewStore,
  markWhatsNewPendingForLogin,
} from '@/store/whatsNewStore';
import { whatsNewApi, type ReleaseNotes } from '@/lib/whats-new';

vi.mock('@/lib/whats-new', () => ({
  whatsNewApi: {
    getWhatsNew: vi.fn(),
    getReleaseNotes: vi.fn(),
    markSeen: vi.fn(),
    remindNextLogin: vi.fn(),
  },
}));

vi.mock('@/lib/tours-api', () => ({
  toursApi: {
    getProgress: vi.fn().mockResolvedValue({}),
    saveProgress: vi.fn().mockResolvedValue({ saved: true }),
    resetProgress: vi.fn().mockResolvedValue({ reset: true }),
  },
}));

const mockApi = vi.mocked(whatsNewApi);

const NOTES: ReleaseNotes = {
  version: '1.12.1',
  intro: 'Intro paragraph.',
  sections: [],
  releaseUrl: 'https://github.com/kenlasko/monize/releases/tag/v1.12.1',
};

async function renderHost() {
  await act(async () => {
    render(<WhatsNewHost />);
  });
}

/**
 * Authenticated *and* arriving from a login, which is what the digest needs to
 * auto-open. `authStore.login()` sets the flag in the real app; setting
 * isAuthenticated directly (as a refresh does) deliberately does not.
 */
function signedInViaLogin() {
  useAuthStore.setState({ isAuthenticated: true });
  markWhatsNewPendingForLogin();
}

describe('WhatsNewHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    useWhatsNewStore.setState({ isOpen: false, pausedForTour: false });
    useTourStore.setState({ active: null, progress: {}, progressLoaded: true });
    useAuthStore.setState({ isAuthenticated: false });
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: false,
      notes: NOTES,
    });
    mockApi.getReleaseNotes.mockResolvedValue({ version: '1.12.1', notes: NOTES });
    mockApi.markSeen.mockResolvedValue({ seen: true, version: '1.12.1' });
    mockApi.remindNextLogin.mockResolvedValue({ reminded: true });
  });

  it('auto-opens for an authenticated user when the backend says so', async () => {
    signedInViaLogin();
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();

    await waitFor(() =>
      expect(screen.getByText('Intro paragraph.')).toBeInTheDocument(),
    );
    expect(mockApi.getWhatsNew).toHaveBeenCalledTimes(1);
    expect(useWhatsNewStore.getState().isOpen).toBe(true);
  });

  it('stays shut on a refresh, even while the version is unacknowledged', async () => {
    // A refresh rehydrates isAuthenticated from localStorage without going
    // through login(), and the backend still reports the user as due this
    // version -- the exact combination that used to reopen the dialog on
    // every page load.
    useAuthStore.setState({ isAuthenticated: true });
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();

    await waitFor(() => expect(mockApi.getWhatsNew).toHaveBeenCalled());
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
    expect(screen.queryByText('Intro paragraph.')).not.toBeInTheDocument();
  });

  it('opens once per login, not again on the refresh that follows', async () => {
    signedInViaLogin();
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();
    await waitFor(() => expect(useWhatsNewStore.getState().isOpen).toBe(true));

    // Same tab, same session, same unacknowledged version: the second mount
    // stands in for the refresh.
    useWhatsNewStore.setState({ isOpen: false, pausedForTour: false });
    await renderHost();

    await waitFor(() => expect(mockApi.getWhatsNew).toHaveBeenCalledTimes(2));
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
  });

  it('arms itself through authStore.login, so a real login opens it', async () => {
    // Guards the wiring: the host trusts login() to set the flag, and nothing
    // else does.
    useAuthStore.getState().login(
      { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'user' } as never,
      'httpOnly',
    );
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();

    await waitFor(() => expect(useWhatsNewStore.getState().isOpen).toBe(true));
  });

  it('spends the login flag even when there is nothing to show', async () => {
    // Logged in on an acknowledged version, so nothing opens. If the flag
    // survived, a later refresh -- after a new version shipped -- would open
    // the dialog outside a login.
    signedInViaLogin();
    await renderHost();
    await waitFor(() => expect(mockApi.getWhatsNew).toHaveBeenCalled());
    expect(useWhatsNewStore.getState().isOpen).toBe(false);

    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.13.0',
      autoShow: true,
      notes: NOTES,
    });
    await renderHost();

    await waitFor(() => expect(mockApi.getWhatsNew).toHaveBeenCalledTimes(2));
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
  });

  it('does not auto-open when the backend says autoShow is false', async () => {
    useAuthStore.setState({ isAuthenticated: true });

    await renderHost();

    await waitFor(() => expect(mockApi.getWhatsNew).toHaveBeenCalled());
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
    expect(screen.queryByText('Intro paragraph.')).not.toBeInTheDocument();
  });

  it('uses the public endpoint (no auto-open) when unauthenticated', async () => {
    await renderHost();

    await waitFor(() => expect(mockApi.getReleaseNotes).toHaveBeenCalledTimes(1));
    expect(mockApi.getWhatsNew).not.toHaveBeenCalled();
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
  });

  it('records the version as seen and closes on "Don\'t show this again"', async () => {
    signedInViaLogin();
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();
    await waitFor(() =>
      expect(screen.getByText('Intro paragraph.')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: "Don't show this again" }),
      );
    });

    expect(mockApi.markSeen).toHaveBeenCalledTimes(1);
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
  });

  it('clears the acknowledgement and closes on "Show at next login"', async () => {
    signedInViaLogin();
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();
    await waitFor(() =>
      expect(screen.getByText('Intro paragraph.')).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Show at next login' }),
      );
    });

    expect(mockApi.remindNextLogin).toHaveBeenCalledTimes(1);
    expect(mockApi.markSeen).not.toHaveBeenCalled();
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
  });

  it('steps aside for a tour from the offer list and comes back when it ends', async () => {
    signedInViaLogin();
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();
    await waitFor(() =>
      expect(screen.getByText('Intro paragraph.')).toBeInTheDocument(),
    );

    // The tour needs the page to itself, so the dialog gets out of the way.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    });
    expect(useTourStore.getState().active).not.toBeNull();
    expect(useWhatsNewStore.getState().isOpen).toBe(false);

    // ...and comes back afterwards, so the rest of the list is reachable.
    await act(async () => {
      useTourStore.getState().endTour('completed');
    });
    expect(useWhatsNewStore.getState().isOpen).toBe(true);
    expect(screen.getByText('Intro paragraph.')).toBeInTheDocument();
  });

  it('stays away when the user left the tour instead of finishing it', async () => {
    signedInViaLogin();
    mockApi.getWhatsNew.mockResolvedValue({
      currentVersion: '1.12.1',
      autoShow: true,
      notes: NOTES,
    });

    await renderHost();
    await waitFor(() =>
      expect(screen.getByText('Intro paragraph.')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    });

    // Escape, End tour, and a browser Back out of the tour all land here. The
    // user is leaving; the dialog must not reappear -- and the pending resume
    // must not survive to fire after some later tour.
    await act(async () => {
      useTourStore.getState().endTour('dismissed');
    });
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
    expect(useWhatsNewStore.getState().pausedForTour).toBe(false);
  });

  it('leaves a dialog the user closed alone when a tour ends', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    await renderHost();
    await waitFor(() => expect(mockApi.getWhatsNew).toHaveBeenCalled());

    // A tour started from Settings or the Getting Started card, with no dialog
    // waiting behind it, must not conjure one up on the way out.
    await act(async () => {
      useTourStore.getState().startTour({
        id: 'test/elsewhere',
        area: 'intro',
        i18nPrefix: 'intro.basics',
        steps: [{ id: 'welcome', anchorId: null }],
      });
    });
    await act(async () => {
      useTourStore.getState().endTour('dismissed');
    });
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
  });
});
