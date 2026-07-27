'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { getErrorMessage } from '@/lib/errors';
import { attachmentsApi, attachmentDownloadUrl } from '@/lib/attachments';
import {
  Attachment,
  ACCEPTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
} from '@/types/attachment';

interface AttachmentsSectionProps {
  transactionId: string;
}

/** Human-readable byte size (e.g. 1.4 MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Lists, uploads, and deletes the file attachments for a saved transaction.
 * Only rendered when a transaction id exists (i.e. when editing) so uploads
 * always have a parent to attach to.
 */
export function AttachmentsSection({ transactionId }: AttachmentsSectionProps) {
  const t = useTranslations('attachments');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [erroredImages, setErroredImages] = useState<Record<string, boolean>>(
    {},
  );
  const [deleteTarget, setDeleteTarget] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await attachmentsApi.list(transactionId);
      setAttachments(list);
    } catch (error) {
      toast.error(getErrorMessage(error, t('loadFailed')));
    }
  }, [transactionId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFileSelected = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after an error/removal.
    event.target.value = '';
    if (!file) return;

    if (attachments.length >= MAX_ATTACHMENTS_PER_TRANSACTION) {
      toast.error(t('tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION }));
      return;
    }
    if (!ACCEPTED_ATTACHMENT_TYPES.includes(file.type)) {
      toast.error(t('unsupported'));
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(t('tooLarge', { max: formatBytes(MAX_ATTACHMENT_BYTES) }));
      return;
    }

    setUploading(true);
    try {
      await attachmentsApi.upload(transactionId, file);
      toast.success(t('uploaded'));
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, t('uploadFailed')));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await attachmentsApi.delete(deleteTarget.id);
      toast.success(t('deleted'));
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, t('deleteFailed')));
    } finally {
      setDeleting(false);
    }
  };

  const atLimit = attachments.length >= MAX_ATTACHMENTS_PER_TRANSACTION;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('title')}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          isLoading={uploading}
          disabled={uploading || atLimit}
          onClick={() => fileInputRef.current?.click()}
        >
          {t('upload')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_ATTACHMENT_TYPES.join(',')}
          className="hidden"
          aria-label={t('upload')}
          onChange={handleFileSelected}
        />
      </div>

      {attachments.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {attachments.map((attachment) => {
            const isImage = attachment.contentType.startsWith('image/');
            const showThumb = isImage && !erroredImages[attachment.id];
            return (
              <li
                key={attachment.id}
                className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-2"
              >
                {showThumb ? (
                  // Served from our own backend; next/image adds no value and
                  // cannot follow the onError fallback.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={attachmentDownloadUrl(attachment.id)}
                    alt={attachment.filename}
                    loading="lazy"
                    className="h-10 w-10 shrink-0 rounded object-cover"
                    onError={() =>
                      setErroredImages((prev) => ({
                        ...prev,
                        [attachment.id]: true,
                      }))
                    }
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gray-100 dark:bg-gray-700 text-lg"
                  >
                    {attachment.contentType === 'application/pdf' ? '📄' : '📎'}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={attachmentDownloadUrl(attachment.id)}
                    download={attachment.filename}
                    className="block truncate text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {attachment.filename}
                  </a>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatBytes(attachment.byteSize)}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('delete')}
                  onClick={() => setDeleteTarget(attachment)}
                >
                  {t('delete')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t('deleteConfirmTitle')}
        message={t('deleteConfirmMessage', { name: deleteTarget?.filename ?? '' })}
        confirmLabel={t('delete')}
        variant="danger"
        pushHistory
        onConfirm={handleDelete}
        onCancel={() => (deleting ? undefined : setDeleteTarget(null))}
      />
    </div>
  );
}
