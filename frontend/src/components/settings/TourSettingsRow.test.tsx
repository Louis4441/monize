import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@/test/render';
import toast from 'react-hot-toast';

const resetProgress = vi.fn().mockResolvedValue({ reset: true });
vi.mock('@/lib/tours-api', () => ({
  toursApi: {
    resetProgress: () => resetProgress(),
    saveProgress: vi.fn().mockResolvedValue({ saved: true }),
  },
}));

import { TourSettingsRow } from './TourSettingsRow';
import { useTourStore } from '@/store/tourStore';
import { ALL_TOURS } from '@/lib/tours/registry';

beforeEach(() => {
  resetProgress.mockClear();
  useTourStore.setState({
    active: null,
    progress: { 'intro/basics': { status: 'completed', updatedAt: 'now' } },
    progressLoaded: true,
  });
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('min-width'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => cleanup());

/** The row whose title matches, so status and button assertions stay scoped. */
function rowFor(title: string) {
  return screen.getByText(title).closest('li') as HTMLElement;
}

describe('TourSettingsRow', () => {
  it('lists every tour the app knows about', () => {
    render(<TourSettingsRow />);
    expect(screen.getAllByRole('listitem')).toHaveLength(ALL_TOURS.length);
    // The release tours are otherwise only reachable from the What's New modal.
    expect(screen.getByText('Foreign currency transactions')).toBeInTheDocument();
    expect(screen.getByText("What's New digest")).toBeInTheDocument();
  });

  it('shows each tour area and viewed state', () => {
    useTourStore.setState({
      progress: {
        'intro/basics': { status: 'completed', updatedAt: 'now' },
        'release-1.13.0/settings': { status: 'dismissed', updatedAt: 'now' },
      },
    });
    render(<TourSettingsRow />);

    expect(
      within(rowFor('New here? Take the introduction tour')).getByText(
        /Getting started · Viewed/,
      ),
    ).toBeInTheDocument();
    expect(
      within(rowFor("What's New digest")).getByText(/Settings · Left early/),
    ).toBeInTheDocument();
    // Never started: no progress entry at all.
    expect(
      within(rowFor('Foreign currency transactions')).getByText(
        /Transactions · Not viewed/,
      ),
    ).toBeInTheDocument();
  });

  it('offers Retake for a viewed tour and Start for an unseen one', () => {
    render(<TourSettingsRow />);
    expect(
      within(rowFor('New here? Take the introduction tour')).getByText('Retake'),
    ).toBeInTheDocument();
    expect(
      within(rowFor('Foreign currency transactions')).getByText('Start'),
    ).toBeInTheDocument();
  });

  it('starts the tour whose button was clicked', () => {
    render(<TourSettingsRow />);
    fireEvent.click(
      within(rowFor('Foreign currency transactions')).getByText('Start'),
    );
    expect(useTourStore.getState().active?.tour.id).toBe(
      'release-1.13.0/foreign-currency',
    );
  });

  it('restarts the introduction tour from its row', () => {
    render(<TourSettingsRow />);
    fireEvent.click(
      within(rowFor('New here? Take the introduction tour')).getByText('Retake'),
    );
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('resets tour progress and clears the local map', async () => {
    render(<TourSettingsRow />);
    fireEvent.click(screen.getByText('Reset tour progress'));
    await waitFor(() => expect(resetProgress).toHaveBeenCalled());
    expect(useTourStore.getState().progress).toEqual({});
    expect(toast.success).toHaveBeenCalled();
  });
});
