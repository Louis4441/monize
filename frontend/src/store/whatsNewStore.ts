import { create } from 'zustand';

/**
 * Controls the "What's New" release-notes modal. Kept separate from the data
 * fetching (handled by WhatsNewHost) so any component -- notably the clickable
 * version labels on the login screen and in Settings -- can reopen the modal.
 */
interface WhatsNewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useWhatsNewStore = create<WhatsNewState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
