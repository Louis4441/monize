import { create } from 'zustand';

/**
 * Controls the "What's New" release-notes modal. Kept separate from the data
 * fetching (handled by WhatsNewHost) so any component -- notably the clickable
 * version labels on the login screen and in Settings -- can reopen the modal.
 */
interface WhatsNewState {
  isOpen: boolean;
  /**
   * The modal stepped aside for a guided tour started from its offer list, so
   * it should come back when that tour ends -- the remaining tours are listed
   * there and were otherwise unreachable afterwards. A plain `close()` (the X,
   * the backdrop, "Don't show this again") clears the flag, so a modal the user
   * really closed stays closed.
   */
  pausedForTour: boolean;
  open: () => void;
  close: () => void;
  /** Step aside for a tour launched from the offer list. */
  closeForTour: () => void;
  /** Bring a paused modal back; a no-op when it was not paused for a tour. */
  resumeAfterTour: () => void;
}

export const useWhatsNewStore = create<WhatsNewState>((set, get) => ({
  isOpen: false,
  pausedForTour: false,
  open: () => set({ isOpen: true, pausedForTour: false }),
  close: () => set({ isOpen: false, pausedForTour: false }),
  closeForTour: () => set({ isOpen: false, pausedForTour: true }),
  resumeAfterTour: () => {
    if (!get().pausedForTour) return;
    set({ isOpen: true, pausedForTour: false });
  },
}));
