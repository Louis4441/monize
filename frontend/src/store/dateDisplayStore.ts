import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Whether register surfaces drop the year from their Date columns -- the
 * day/month view, born on phone widths to free width for the payee and now a
 * view the user can choose at any width.
 *
 * One global flag rather than a per-view bucket: which date view the user
 * prefers is the same question on every register surface, so the toggle on
 * one register applies to all of them. Where it applies is the surface's
 * decision: the transaction register honours it at every width, while the
 * reconcile table only shortens below `sm`, where its columns crowd.
 *
 * The field keeps its historical `compactMobileDates` name because it is the
 * persisted shape -- renaming it would silently drop every user's saved
 * choice.
 *
 * Browser-local rather than a row in `user_preferences` for the same reason
 * row density is (see densityStore.ts): what fits on the screen in front of
 * the user is a fact about that screen, so a phone and a desktop signed into
 * the same account should not have to agree.
 */
export const DATE_DISPLAY_STORAGE_KEY = 'monize-register-date-display';

interface DateDisplayState {
  compactMobileDates: boolean;
  toggleCompactMobileDates: () => void;
}

export const useDateDisplayStore = create<DateDisplayState>()(
  persist(
    (set) => ({
      compactMobileDates: false,

      toggleCompactMobileDates: () =>
        set((state) => ({ compactMobileDates: !state.compactMobileDates })),
    }),
    {
      name: DATE_DISPLAY_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The action is recreated on load; only the flag is worth storing.
      partialize: (state) => ({ compactMobileDates: state.compactMobileDates }),
      // A hand-edited or truncated entry is not a reason to render a broken
      // register -- anything that is not a boolean falls back to the default.
      merge: (persisted, current) => {
        const stored = (persisted as { compactMobileDates?: unknown } | undefined)
          ?.compactMobileDates;
        return {
          ...current,
          compactMobileDates: typeof stored === 'boolean' ? stored : false,
        };
      },
    }
  )
);

/**
 * The one way a register reads and flips the mobile date shortening.
 */
export function useCompactMobileDates() {
  const compactMobileDates = useDateDisplayStore((state) => state.compactMobileDates);
  const toggleCompactMobileDates = useDateDisplayStore(
    (state) => state.toggleCompactMobileDates
  );

  return { compactMobileDates, toggleCompactMobileDates };
}
