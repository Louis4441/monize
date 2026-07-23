import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { WhatsNewHost } from './WhatsNewHost';
import { useAuthStore } from '@/store/authStore';
import { useWhatsNewStore } from '@/store/whatsNewStore';
import { whatsNewApi, type ReleaseNotes } from '@/lib/whats-new';

vi.mock('@/lib/whats-new', () => ({
  whatsNewApi: {
    getWhatsNew: vi.fn(),
    getReleaseNotes: vi.fn(),
    markSeen: vi.fn(),
    remindNextLogin: vi.fn(),
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

describe('WhatsNewHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWhatsNewStore.setState({ isOpen: false });
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
    useAuthStore.setState({ isAuthenticated: true });
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
    useAuthStore.setState({ isAuthenticated: true });
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
    useAuthStore.setState({ isAuthenticated: true });
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
});
