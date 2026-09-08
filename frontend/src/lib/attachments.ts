import apiClient from './api';
import { Attachment } from '@/types/attachment';
import { invalidateCache } from './apiCache';

/**
 * Same-origin URL for an attachment's bytes. Rendered directly in an <img> (for
 * images) or an <a download> (for any type); the request carries the auth cookie
 * and streams straight from the backend.
 */
export function attachmentDownloadUrl(id: string): string {
  return `/api/v1/attachments/${id}/download`;
}

/** An attachment's bytes, as the preview reads them. */
export interface AttachmentBytes {
  bytes: ArrayBuffer;
  /** What the server said the bytes are (it sniffed them on upload). */
  contentType: string;
}

/**
 * The preview reads a whole file, and a 10 MB scan over a phone connection
 * takes longer than the client's 10 s default.
 */
export const ATTACHMENT_BYTES_TIMEOUT_MS = 60_000;

export const attachmentsApi = {
  list: async (transactionId: string): Promise<Attachment[]> => {
    const response = await apiClient.get<Attachment[]>(
      `/transactions/${transactionId}/attachments`,
    );
    return response.data;
  },

  /**
   * Upload one attachment, optionally with the unprocessed photo it was
   * scanned from.
   *
   * Both parts travel in ONE request because the server writes them in one
   * transaction: uploading the original separately would leave a window where
   * the pair is half stored, and a failure would leave an orphan the user can
   * see but not explain.
   */
  upload: async (
    transactionId: string,
    file: File,
    original?: File,
  ): Promise<Attachment> => {
    const formData = new FormData();
    formData.append('file', file);
    if (original) formData.append('original', original);
    const response = await apiClient.post<Attachment>(
      `/transactions/${transactionId}/attachments`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    invalidateCache('attachments:');
    return response.data;
  },

  /**
   * The bytes behind an attachment, for the in-app preview.
   *
   * Through the axios client rather than a bare `<img src>` or a plain
   * `fetch`, so the 401-refresh interceptor applies: an `<img>` whose access
   * token expired simply fails to load, with nothing able to refresh it. The
   * same-origin URL and credentials mean the request is still answered from
   * the HTTP cache the row's thumbnail primed. `signal` lets a closed preview
   * abandon a transfer it no longer needs.
   */
  fetchBytes: async (
    id: string,
    signal?: AbortSignal,
  ): Promise<AttachmentBytes> => {
    const response = await apiClient.get<ArrayBuffer>(
      `/attachments/${id}/download`,
      {
        responseType: 'arraybuffer',
        timeout: ATTACHMENT_BYTES_TIMEOUT_MS,
        signal,
      },
    );
    const header = response.headers?.['content-type'];
    return {
      bytes: response.data,
      contentType:
        typeof header === 'string' && header.length > 0
          ? header.split(';')[0].trim()
          : 'application/octet-stream',
    };
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/attachments/${id}`);
    invalidateCache('attachments:');
  },
};
