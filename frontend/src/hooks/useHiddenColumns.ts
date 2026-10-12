import { useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  HIDEABLE_COLUMNS,
  hiddenColumnsFor,
  withHiddenColumns,
  type HiddenColumnTable,
  type HideableColumn,
} from '@/lib/hidden-columns';

const logger = createLogger('useHiddenColumns');

export interface UseHiddenColumnsResult<T extends HiddenColumnTable> {
  /** The table kind's hidden columns (known ids only). */
  hidden: ReadonlySet<HideableColumn<T>>;
  /** True for every column that is not hidden, structural columns included. */
  isVisible: (id: string) => boolean;
  hide: (id: HideableColumn<T>) => Promise<void>;
  show: (id: HideableColumn<T>) => Promise<void>;
  showAll: () => Promise<void>;
  /** The kind's hideable columns, in display order. */
  hideable: readonly HideableColumn<T>[];
}

/**
 * Hidden columns of one table kind, backed by the cross-device
 * `hiddenTableColumns` preference (a map keyed by table kind). The write is
 * `useWidgetConfig`'s: read the freshest map from the store, update it
 * optimistically, send the whole map, adopt the saved map, and revert with a
 * toast on failure.
 */
export function useHiddenColumns<T extends HiddenColumnTable>(
  table: T,
): UseHiddenColumnsResult<T> {
  const t = useTranslations('common');
  const stored = usePreferencesStore((s) => s.preferences?.hiddenTableColumns?.[table]);

  const hidden = useMemo(
    () => new Set(hiddenColumnsFor({ [table]: stored }, table)),
    [table, stored],
  );

  const isVisible = useCallback(
    (id: string) => !(hidden as ReadonlySet<string>).has(id),
    [hidden],
  );

  const save = useCallback(
    async (update: (current: HideableColumn<T>[]) => HideableColumn<T>[]) => {
      // Read the freshest map straight from the store (not a render-time
      // closure) so near-simultaneous edits from two tables don't clobber
      // each other.
      const state = usePreferencesStore.getState();
      const allBefore = state.preferences?.hiddenTableColumns ?? {};
      const nextAll = withHiddenColumns(
        allBefore,
        table,
        update(hiddenColumnsFor(allBefore, table)),
      );

      // Optimistic update so the table re-renders immediately.
      state.updatePreferences({ hiddenTableColumns: nextAll });

      try {
        const saved = await userSettingsApi.updatePreferences({
          hiddenTableColumns: nextAll,
        });
        usePreferencesStore.getState().updatePreferences({
          hiddenTableColumns: saved.hiddenTableColumns,
        });
      } catch (error) {
        logger.error('Failed to save hidden columns:', error);
        // Revert to the pre-edit map.
        usePreferencesStore.getState().updatePreferences({
          hiddenTableColumns: allBefore,
        });
        toast.error(getErrorMessage(error, t('columns.saveFailed')));
      }
    },
    [table, t],
  );

  const hide = useCallback(
    (id: HideableColumn<T>) => save((current) => [...current, id]),
    [save],
  );
  const show = useCallback(
    (id: HideableColumn<T>) => save((current) => current.filter((c) => c !== id)),
    [save],
  );
  const showAll = useCallback(() => save(() => []), [save]);

  return {
    hidden,
    isVisible,
    hide,
    show,
    showAll,
    hideable: HIDEABLE_COLUMNS[table] as readonly HideableColumn<T>[],
  };
}
