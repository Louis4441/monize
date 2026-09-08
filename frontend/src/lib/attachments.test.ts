import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { attachmentsApi, ATTACHMENT_BYTES_TIMEOUT_MS } from './attachments';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const mockGet = apiClient.get as ReturnType<typeof vi.fn>;

describe('attachmentsApi.fetchBytes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the bytes as an array buffer with a long timeout and the caller signal', async () => {
    const bytes = new Uint8Array([1, 2]).buffer;
    mockGet.mockResolvedValue({
      data: bytes,
      headers: { 'content-type': 'image/png' },
    });
    const controller = new AbortController();

    const result = await attachmentsApi.fetchBytes('a-1', controller.signal);

    expect(mockGet).toHaveBeenCalledWith('/attachments/a-1/download', {
      responseType: 'arraybuffer',
      timeout: ATTACHMENT_BYTES_TIMEOUT_MS,
      signal: controller.signal,
    });
    expect(ATTACHMENT_BYTES_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(result).toEqual({ bytes, contentType: 'image/png' });
  });

  it('takes the type from the server, without its parameters', async () => {
    mockGet.mockResolvedValue({
      data: new ArrayBuffer(0),
      headers: { 'content-type': 'application/pdf; charset=binary' },
    });
    const result = await attachmentsApi.fetchBytes('a-1');
    expect(result.contentType).toBe('application/pdf');
  });

  it('falls back to an opaque type when the server sends none', async () => {
    mockGet.mockResolvedValue({ data: new ArrayBuffer(0), headers: {} });
    const result = await attachmentsApi.fetchBytes('a-1');
    expect(result.contentType).toBe('application/octet-stream');
  });
});
