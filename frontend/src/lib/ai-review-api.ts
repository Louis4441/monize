import apiClient from './api';
import type { AiReviewFilter, AiReviewItem } from '@/types/ai-review';

/**
 * The review inbox. Deliberately uncached: the queue changes under the page
 * (an agent claims, proposes, an expiry cron runs), so a list served from a
 * cache would offer an Approve for a request that is no longer open.
 *
 * Approval is not here. A proposal is a signed pending action and is committed
 * by `aiApi.confirmAction`, the same client the chat uses.
 */
export const aiReviewApi = {
  /** `open` sends no status: the server answers what is waiting plus expired. */
  list: async (filter: AiReviewFilter): Promise<AiReviewItem[]> => {
    const response = await apiClient.get<AiReviewItem[]>('/ai-review-requests', {
      params: filter === 'open' ? undefined : { status: filter },
    });
    return response.data;
  },

  dismiss: async (id: string): Promise<AiReviewItem> => {
    const response = await apiClient.post<AiReviewItem>(`/ai-review-requests/${id}/dismiss`);
    return response.data;
  },
};
