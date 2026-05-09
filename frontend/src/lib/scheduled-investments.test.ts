import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { scheduledInvestmentsApi } from './scheduled-investments';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('./apiCache', () => ({
  dedupe: (_key: string, fn: () => unknown) => fn(),
  invalidateCache: vi.fn(),
}));

describe('scheduledInvestmentsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create POSTs to /scheduled-investment-transactions', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'si-1' } });
    const r = await scheduledInvestmentsApi.create({ name: 'VOO DCA' } as any);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/scheduled-investment-transactions',
      { name: 'VOO DCA' },
    );
    expect(r.id).toBe('si-1');
  });

  it('getAll GETs /scheduled-investment-transactions', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await scheduledInvestmentsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith(
      '/scheduled-investment-transactions',
    );
  });

  it('getUpcoming forwards days param', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await scheduledInvestmentsApi.getUpcoming(7);
    expect(apiClient.get).toHaveBeenCalledWith(
      '/scheduled-investment-transactions/upcoming',
      { params: { days: 7 } },
    );
  });

  it('getById fetches by id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'si-1' } });
    await scheduledInvestmentsApi.getById('si-1');
    expect(apiClient.get).toHaveBeenCalledWith(
      '/scheduled-investment-transactions/si-1',
    );
  });

  it('update PATCHes by id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'si-1' } });
    await scheduledInvestmentsApi.update('si-1', { name: 'Updated' });
    expect(apiClient.patch).toHaveBeenCalledWith(
      '/scheduled-investment-transactions/si-1',
      { name: 'Updated' },
    );
  });

  it('delete DELETEs by id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });
    await scheduledInvestmentsApi.delete('si-1');
    expect(apiClient.delete).toHaveBeenCalledWith(
      '/scheduled-investment-transactions/si-1',
    );
  });

  it('post forwards optional override payload', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'si-1' } });
    await scheduledInvestmentsApi.post('si-1', { quantity: 10 });
    expect(apiClient.post).toHaveBeenCalledWith(
      '/scheduled-investment-transactions/si-1/post',
      { quantity: 10 },
    );
  });

  it('skip POSTs to /skip endpoint', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'si-1' } });
    await scheduledInvestmentsApi.skip('si-1');
    expect(apiClient.post).toHaveBeenCalledWith(
      '/scheduled-investment-transactions/si-1/skip',
      {},
    );
  });
});
