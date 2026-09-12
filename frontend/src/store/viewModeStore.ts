import { useCallback } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Which view a screen is showing, and which of the calendar's layers are on.
 *
 * Browser-local rather than a `user_preferences` column, for the reason the
 * density store is: how a screen is laid out is a fact about the screen in
 * front of the reader, so a laptop and a desktop signed into the same account
 * need not agree about whether the register is a table or a month grid. It is
 * not a URL parameter either -- a shared link should open the page, not impose
 * the sender's reading habit on the recipient.
 */
export const VIEW_MODE_STORAGE_KEY = 'monize-view-mode';

/** A screen that offers the Table / Calendar switch. */
export type ViewModeSurface = 'transactions' | 'investments';

export type ViewMode = 'table' | 'calendar';

/**
 * A calendar layer: one independently switchable body of figures drawn over
 * the month grid.
 */
export type CalendarLayer = 'transactions' | 'balances' | 'values' | 'dailyChange';

/**
 * The layers each surface offers, in the order its toolbar lists them.
 *
 * A union per surface rather than one flat list, so asking the investments
 * calendar for a `balances` layer is a compile error rather than a toggle that
 * silently does nothing.
 */
export const SURFACE_LAYERS: Readonly<Record<ViewModeSurface, readonly CalendarLayer[]>> = {
  transactions: ['transactions', 'balances'],
  investments: ['transactions', 'values', 'dailyChange'],
};

export const VIEW_MODE_SURFACES: readonly ViewModeSurface[] = ['transactions', 'investments'];

const VIEW_MODES: readonly ViewMode[] = ['table', 'calendar'];

export interface SurfaceViewState {
  view: ViewMode;
  layers: CalendarLayer[];
}

/**
 * Table, with the Transactions layer ready for the first switch to Calendar.
 *
 * Defaulting to `table` is what makes every calendar task inert on deploy: a
 * user who never touches the toggle sees exactly the register they saw before.
 */
function defaultSurfaceState(): SurfaceViewState {
  return { view: 'table', layers: ['transactions'] };
}

function defaultSurfaces(): Record<ViewModeSurface, SurfaceViewState> {
  return { transactions: defaultSurfaceState(), investments: defaultSurfaceState() };
}

function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

function isLayerOfSurface(surface: ViewModeSurface, value: unknown): value is CalendarLayer {
  return typeof value === 'string' && (SURFACE_LAYERS[surface] as readonly string[]).includes(value);
}

/**
 * A stored surface, or the default when the stored one cannot be trusted.
 *
 * A hand-edited entry, a layer belonging to the other surface, or a surface
 * left with no layer at all is discarded rather than rendered: the toolbar's
 * one rule is that a calendar always draws something.
 */
function readSurface(surface: ViewModeSurface, stored: unknown): SurfaceViewState {
  const candidate = stored as { view?: unknown; layers?: unknown } | undefined;
  if (!candidate || typeof candidate !== 'object') return defaultSurfaceState();

  const view = isViewMode(candidate.view) ? candidate.view : 'table';
  const storedLayers: unknown[] = Array.isArray(candidate.layers) ? candidate.layers : [];
  const layers = SURFACE_LAYERS[surface].filter(
    (layer) => storedLayers.includes(layer) && isLayerOfSurface(surface, layer),
  );

  return { view, layers: layers.length > 0 ? [...layers] : defaultSurfaceState().layers };
}

interface ViewModeState {
  surfaces: Record<ViewModeSurface, SurfaceViewState>;
  setView: (surface: ViewModeSurface, view: ViewMode) => void;
  toggleLayer: (surface: ViewModeSurface, layer: CalendarLayer) => void;
}

export const useViewModeStore = create<ViewModeState>()(
  persist(
    (set) => ({
      surfaces: defaultSurfaces(),

      setView: (surface, view) =>
        set((state) => ({
          surfaces: { ...state.surfaces, [surface]: { ...state.surfaces[surface], view } },
        })),

      /**
       * Switch a layer on, or off unless it is the last one standing.
       *
       * At least one layer is always on (design section 1): a calendar with
       * every layer off is a month of empty boxes, which reads as a page that
       * failed to load rather than as a choice the reader made.
       */
      toggleLayer: (surface, layer) =>
        set((state) => {
          const current = state.surfaces[surface];
          const isOn = current.layers.includes(layer);
          if (isOn && current.layers.length === 1) return state;

          const layers = SURFACE_LAYERS[surface].filter((candidate) =>
            candidate === layer ? !isOn : current.layers.includes(candidate),
          );

          return { surfaces: { ...state.surfaces, [surface]: { ...current, layers: [...layers] } } };
        }),
    }),
    {
      name: VIEW_MODE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The actions are recreated on load; only the choices are worth storing.
      partialize: (state) => ({ surfaces: state.surfaces }),
      merge: (persisted, current) => {
        const stored = (persisted as { surfaces?: Record<string, unknown> } | undefined)?.surfaces;
        const surfaces = defaultSurfaces();

        if (stored && typeof stored === 'object') {
          for (const surface of VIEW_MODE_SURFACES) {
            surfaces[surface] = readSurface(surface, stored[surface]);
          }
        }

        return { ...current, surfaces };
      },
    },
  ),
);

/**
 * The one way a surface reads and changes its own view and layers.
 *
 * Selectors are subscribed per surface so the Transactions page does not
 * re-render when the Investments page's toggle moves, and the actions are
 * bound to the surface so a caller cannot write to the other one by forgetting
 * an argument.
 */
export function useViewMode(surface: ViewModeSurface) {
  const view = useViewModeStore((state) => state.surfaces[surface].view);
  const layers = useViewModeStore((state) => state.surfaces[surface].layers);
  const setForSurface = useViewModeStore((state) => state.setView);
  const toggleForSurface = useViewModeStore((state) => state.toggleLayer);

  const setView = useCallback(
    (next: ViewMode) => setForSurface(surface, next),
    [setForSurface, surface],
  );
  const toggleLayer = useCallback(
    (layer: CalendarLayer) => toggleForSurface(surface, layer),
    [toggleForSurface, surface],
  );
  const isLayerOn = useCallback((layer: CalendarLayer) => layers.includes(layer), [layers]);

  return { view, setView, layers, toggleLayer, isLayerOn };
}
