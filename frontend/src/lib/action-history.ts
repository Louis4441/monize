import apiClient from './api';
import { clearAllCache } from './apiCache';

export interface ActionHistoryItem {
  id: string;
  userId: string;
  entityType: string;
  entityId: string | null;
  action: string;
  isUndone: boolean;
  // English source string; rendered as-is only when no localizable key is present.
  description: string;
  // Stable key (e.g. "createdPayee") + interpolation values the client uses to
  // render the description in the user's current language. Null on older records
  // written before localization, in which case `description` is the fallback.
  descriptionKey?: string | null;
  descriptionParams?: Record<string, string | number> | null;
  createdAt: string;
}

export interface UndoRedoResult {
  action: ActionHistoryItem;
  description: string;
}

export const actionHistoryApi = {
  getHistory: async (limit?: number): Promise<ActionHistoryItem[]> => {
    const { data } = await apiClient.get<ActionHistoryItem[]>('/action-history', {
      params: limit ? { limit } : undefined,
    });
    return data;
  },

  // Undo/redo can reverse a write to any entity, so there is no prefix narrow
  // enough to be correct. Clearing everything also keeps the promise made by
  // `notifyUndoRedo`: subscribers refetch, and without this the refetch is
  // served from the cache that the reversed write left behind.
  undo: async (): Promise<UndoRedoResult> => {
    const { data } = await apiClient.post<UndoRedoResult>('/action-history/undo');
    clearAllCache();
    return data;
  },

  redo: async (): Promise<UndoRedoResult> => {
    const { data } = await apiClient.post<UndoRedoResult>('/action-history/redo');
    clearAllCache();
    return data;
  },
};
