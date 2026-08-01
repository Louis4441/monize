import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { gemStrategyApi } from './gem-strategy';
import { gemReport } from '@/test/gem-fixtures';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

describe('gemStrategyApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the report for the default range', async () => {
    const report = gemReport();
    vi.mocked(apiClient.get).mockResolvedValue({ data: report } as never);
    await expect(gemStrategyApi.getReport()).resolves.toEqual(report);
    expect(apiClient.get).toHaveBeenCalledWith('/strategies/gem/report', {
      params: { range: '1Y' },
    });
  });

  it('passes the selected range through', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: gemReport() } as never);
    await gemStrategyApi.getReport('MAX');
    expect(apiClient.get).toHaveBeenCalledWith('/strategies/gem/report', {
      params: { range: 'MAX' },
    });
  });

  it('saves the configuration and returns the refreshed report', async () => {
    const report = gemReport();
    vi.mocked(apiClient.put).mockResolvedValue({ data: report } as never);
    await expect(
      gemStrategyApi.updateConfig(
        {
          accountIds: ['acct-1', 'acct-2'],
          cadence: 'QUARTERLY',
          assets: [{ role: 'EM_EQUITY', securityId: 'sec-emim' }],
        },
        '6M',
      ),
    ).resolves.toEqual(report);
    expect(apiClient.put).toHaveBeenCalledWith(
      '/strategies/gem',
      {
        accountIds: ['acct-1', 'acct-2'],
        cadence: 'QUARTERLY',
        assets: [{ role: 'EM_EQUITY', securityId: 'sec-emim' }],
      },
      // A save can trigger a provider fetch, so it outlives the 10s default.
      { params: { range: '6M' }, timeout: 120_000 },
    );
  });

  it('marks a signal executed and returns the refreshed report', async () => {
    const report = gemReport();
    vi.mocked(apiClient.post).mockResolvedValue({ data: report } as never);
    await expect(gemStrategyApi.markExecuted('signal-1', '3M')).resolves.toEqual(report);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/strategies/gem/signals/signal-1/executed',
      {},
      { params: { range: '3M' } },
    );
  });
});
