import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import {
  ATTACHMENT_STORE_UNREACHABLE_CODE,
  isStoreUnreachable,
} from './attachments';
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

describe('isStoreUnreachable', () => {
  const refusal = (data: unknown, status = 503) =>
    Object.assign(new Error('refused'), { isAxiosError: true, response: { status, data } });

  const coded = JSON.stringify({ code: ATTACHMENT_STORE_UNREACHABLE_CODE });

  it('recognises the coded refusal however axios handed the body over', () => {
    // The download asks for an arraybuffer, so the body of the refusal arrives as
    // bytes; other callers get it parsed. Both are the same answer.
    expect(isStoreUnreachable(refusal(new TextEncoder().encode(coded).buffer))).toBe(true);
    expect(isStoreUnreachable(refusal(new TextEncoder().encode(coded)))).toBe(true);
    expect(isStoreUnreachable(refusal(coded))).toBe(true);
    expect(isStoreUnreachable(refusal({ code: ATTACHMENT_STORE_UNREACHABLE_CODE }))).toBe(true);
  });

  it('does not claim it for a 503 that is not this refusal', () => {
    // A proxy answering 503 while the backend restarts, and the same code on a
    // different status: neither says this attachment's storage is unconfigured.
    expect(isStoreUnreachable(refusal('<html>503</html>'))).toBe(false);
    expect(isStoreUnreachable(refusal({ message: 'busy' }))).toBe(false);
    expect(isStoreUnreachable(refusal(undefined))).toBe(false);
    expect(isStoreUnreachable(refusal(coded, 500))).toBe(false);
    expect(isStoreUnreachable(new Error('offline'))).toBe(false);
  });
});
