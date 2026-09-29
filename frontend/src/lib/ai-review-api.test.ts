import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { aiReviewApi } from './ai-review-api';

vi.mock('./api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

describe('aiReviewApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the default view without a status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'r-1' }] });
    expect(await aiReviewApi.list('open')).toEqual([{ id: 'r-1' }]);
    expect(apiClient.get).toHaveBeenCalledWith('/ai-review-requests', { params: undefined });
  });

  it('lists one status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await aiReviewApi.list('proposed');
    expect(apiClient.get).toHaveBeenCalledWith('/ai-review-requests', { params: { status: 'proposed' } });
  });

  it('posts a dismissal to the request', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'r-1', status: 'rejected' } });
    expect(await aiReviewApi.dismiss('r-1')).toEqual({ id: 'r-1', status: 'rejected' });
    expect(apiClient.post).toHaveBeenCalledWith('/ai-review-requests/r-1/dismiss');
  });
});
