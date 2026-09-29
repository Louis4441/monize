import apiClient from './api';
import { clearAllCache, dedupe, invalidateCache } from './apiCache';
import type {
  CreateTransactionRuleData,
  TransactionRule,
  UpdateTransactionRuleData,
} from '@/types/transaction-rule';
import type {
  PreviewDraftRuleData,
  RuleApplication,
  RuleRunFilters,
  RuleRunPreview,
  RuleRunResult,
} from '@/types/transaction-rule-run';

const CACHE_PREFIX = 'transaction-rules:';

/** Evaluation-order list; short-lived because an import or the AI can change it. */
const LIST_TTL_MS = 60_000;

/**
 * Runs a write and drops the cached list afterwards, whether the write
 * succeeded or was refused: a 409 means the list moved under the caller, so
 * the reload that follows must not be served the payload the caller was
 * already looking at.
 */
async function write<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } finally {
    invalidateCache(CACHE_PREFIX);
  }
}

export const transactionRulesApi = {
  getAll: async (): Promise<TransactionRule[]> => {
    return dedupe(
      `${CACHE_PREFIX}all`,
      async () => {
        const response = await apiClient.get<TransactionRule[]>('/transaction-rules');
        return response.data;
      },
      LIST_TTL_MS,
    );
  },

  /** Never cached: the editor needs the current `revision`. */
  getById: async (id: string): Promise<TransactionRule> => {
    const response = await apiClient.get<TransactionRule>(`/transaction-rules/${id}`);
    return response.data;
  },

  create: (data: CreateTransactionRuleData): Promise<TransactionRule> =>
    write(async () => {
      const response = await apiClient.post<TransactionRule>('/transaction-rules', data);
      return response.data;
    }),

  update: (id: string, data: UpdateTransactionRuleData): Promise<TransactionRule> =>
    write(async () => {
      const response = await apiClient.patch<TransactionRule>(`/transaction-rules/${id}`, data);
      return response.data;
    }),

  setEnabled: (id: string, enabled: boolean): Promise<TransactionRule> =>
    write(async () => {
      const response = await apiClient.patch<TransactionRule>(
        `/transaction-rules/${id}/enabled`,
        { enabled },
      );
      return response.data;
    }),

  /** `ids` is every rule of the user in the new order; answers the reordered list. */
  reorder: (ids: readonly string[]): Promise<TransactionRule[]> =>
    write(async () => {
      const response = await apiClient.put<TransactionRule[]>('/transaction-rules/reorder', {
        ids,
      });
      return response.data;
    }),

  delete: (id: string): Promise<void> =>
    write(async () => {
      await apiClient.delete(`/transaction-rules/${id}`);
    }),

  /** Tests an unsaved rule against existing transactions. Writes nothing. */
  previewDraft: async (data: PreviewDraftRuleData): Promise<RuleRunPreview> => {
    const response = await apiClient.post<RuleRunPreview>('/transaction-rules/preview-draft', data);
    return response.data;
  },

  /** What a manual run of a saved rule would change. Writes nothing. */
  previewRun: async (id: string, filters: RuleRunFilters): Promise<RuleRunPreview> => {
    const response = await apiClient.post<RuleRunPreview>(`/transaction-rules/${id}/preview-run`, filters);
    return response.data;
  },

  /**
   * Commits the preview whose `fingerprint` is sent. A run rewrites category,
   * payee and tags of any transaction, and undo can reverse it, so no cache
   * prefix is narrow enough: everything is dropped once the write succeeded.
   * A refused run (409 PREVIEW_CHANGED, 400) wrote nothing and keeps the cache.
   */
  run: async (id: string, filters: RuleRunFilters, fingerprint: string): Promise<RuleRunResult> => {
    const response = await apiClient.post<RuleRunResult>(`/transaction-rules/${id}/run`, {
      ...filters,
      fingerprint,
    });
    clearAllCache();
    return response.data;
  },

  /** The latest applications of one rule, newest first. Never cached. */
  getApplications: async (id: string, limit?: number): Promise<RuleApplication[]> => {
    const response = await apiClient.get<RuleApplication[]>(`/transaction-rules/${id}/applications`, {
      params: limit ? { limit } : undefined,
    });
    return response.data;
  },
};
