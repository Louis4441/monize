'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, ButtonLink } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useAttachmentBytes, type PreviewSource } from '@/hooks/useAttachmentBytes';
import { attachmentDownloadUrl } from '@/lib/attachments';
import { downloadBlob } from '@/lib/download';
import type { Attachment } from '@/types/attachment';
import { PdfPages } from './PdfPages';

/**
 * What the preview is showing: a saved attachment (its original, when it
 * has one, is reached through `originalAttachmentId` and the same download
 * route), or a file staged in the New Transaction window, with the photo it
 * was scanned from when the user kept it.
 */
export type PreviewTarget =
  | { kind: 'saved'; attachment: Attachment }
  | { kind: 'file'; file: File; original?: File };

type Variant = 'enhanced' | 'original';
type Fit = 'fit' | 'actual';

function targetName(target: PreviewTarget): string {
  return target.kind === 'saved' ? target.attachment.filename : target.file.name;
}

function hasOriginal(target: PreviewTarget): boolean {
  return target.kind === 'saved'
    ? !!target.attachment.originalAttachmentId
    : target.original !== undefined;
}

function sourceFor(target: PreviewTarget, variant: Variant): PreviewSource {
  if (target.kind === 'saved') {
    const id =
      variant === 'original' && target.attachment.originalAttachmentId
        ? target.attachment.originalAttachmentId
        : target.attachment.id;
    return { kind: 'saved', id };
  }
  return {
    kind: 'file',
    file: variant === 'original' && target.original ? target.original : target.file,
  };
}

/**
 * Opens an attachment inside the app instead of handing it to the browser.
 *
 * Images and PDFs are the only types an upload accepts, and both are drawn
 * here: an image from a blob URL, a PDF by `PdfPages`. Download is offered
 * from the footer for whichever variant is on screen -- for a saved original
 * the server names the file through Content-Disposition, since the list does
 * not carry the original's own filename.
 *
 * On a phone the dialog fills the viewport (`fullScreenOnPhone`); on anything
 * wider it is the ordinary centred card, tall enough to read a page.
 */
export function AttachmentPreviewDialog({
  isOpen,
  target,
  onClose,
}: {
  isOpen: boolean;
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations('attachments');
  const tCommon = useTranslations('common');

  // Variant and zoom belong to one target; a new target starts over. Tracked
  // by the previous-render pattern rather than reset in an effect.
  const [viewState, setViewState] = useState<{
    target: PreviewTarget | null;
    variant: Variant;
    fit: Fit;
  }>({ target, variant: 'enhanced', fit: 'fit' });
  if (viewState.target !== target) {
    setViewState({ target, variant: 'enhanced', fit: 'fit' });
  }
  const variant = viewState.target === target ? viewState.variant : 'enhanced';
  const fit = viewState.target === target ? viewState.fit : 'fit';
  const setVariant = (next: Variant) =>
    setViewState((prev) => ({ ...prev, target, variant: next }));
  const setFit = (next: Fit) =>
    setViewState((prev) => ({ ...prev, target, fit: next }));

  const source = isOpen && target ? sourceFor(target, variant) : null;
  const bytes = useAttachmentBytes(source);

  const ready = bytes?.status === 'ready' ? bytes : null;
  const isImage = ready?.contentType.startsWith('image/') ?? false;
  const isPdf = ready?.contentType === 'application/pdf';

  // Object URLs for the image, made from the bytes on screen and revoked when
  // they change. Guarded for environments (jsdom) without createObjectURL.
  const imageUrl = useMemo(
    () =>
      ready && isImage && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(
            new Blob([ready.bytes], { type: ready.contentType }),
          )
        : null,
    [ready, isImage],
  );
  useEffect(
    () => () => {
      if (imageUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(imageUrl);
      }
    },
    [imageUrl],
  );

  if (!target) return null;

  const name = targetName(target);
  const showingOriginal = variant === 'original' && hasOriginal(target);

  const download =
    target.kind === 'saved' ? (
      <ButtonLink
        href={attachmentDownloadUrl(
          showingOriginal && target.attachment.originalAttachmentId
            ? target.attachment.originalAttachmentId
            : target.attachment.id,
        )}
        // The original's filename is the server's to give; the visible
        // attachment's is known here.
        download={showingOriginal ? '' : target.attachment.filename}
        variant="outline"
        size="md"
      >
        {t('download')}
      </ButtonLink>
    ) : (
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          const file =
            showingOriginal && target.original ? target.original : target.file;
          downloadBlob(file, file.name);
        }}
      >
        {t('download')}
      </Button>
    );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={name}
      maxWidth="6xl"
      pushHistory
      fullScreenOnPhone
      className="flex flex-col sm:h-[90vh]"
      footer={
        <>
          {download}
          <Button type="button" variant="primary" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </>
      }
    >
      {(hasOriginal(target) || isImage) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2 sm:px-6 dark:border-gray-700">
          {hasOriginal(target) && (
            <>
              {/* Two buttons rather than a tablist, as the scan dialog does:
                  a preview switch inside a dialog is not page navigation. */}
              <Button
                type="button"
                size="sm"
                variant={variant === 'enhanced' ? 'primary' : 'outline'}
                onClick={() => setVariant('enhanced')}
                aria-pressed={variant === 'enhanced'}
              >
                {t('scan.viewEnhanced')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={variant === 'original' ? 'primary' : 'outline'}
                onClick={() => setVariant('original')}
                aria-pressed={variant === 'original'}
              >
                {t('scan.viewOriginal')}
              </Button>
            </>
          )}
          {isImage && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={fit === 'fit' ? 'primary' : 'outline'}
                onClick={() => setFit('fit')}
                aria-pressed={fit === 'fit'}
              >
                {t('preview.fit')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={fit === 'actual' ? 'primary' : 'outline'}
                onClick={() => setFit('actual')}
                aria-pressed={fit === 'actual'}
              >
                {t('preview.actualSize')}
              </Button>
            </div>
          )}
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-auto bg-gray-100 p-4 dark:bg-gray-900"
        aria-busy={bytes?.status === 'loading'}
      >
        {bytes?.status === 'loading' && (
          <LoadingSpinner text={t('preview.loading')} />
        )}
        {bytes?.status === 'error' && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            {t('preview.failed')}
          </div>
        )}
        {ready && isImage && imageUrl && (
          // Served from our own bytes; next/image adds nothing here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={name}
            className={
              fit === 'fit'
                ? 'mx-auto max-h-full max-w-full object-contain'
                : 'max-w-none'
            }
          />
        )}
        {ready && isPdf && <PdfPages bytes={ready.bytes} label={name} />}
        {ready && !isImage && !isPdf && (
          <p className="text-center text-sm text-gray-600 dark:text-gray-300">
            {t('preview.unsupported')}
          </p>
        )}
      </div>
    </Modal>
  );
}
