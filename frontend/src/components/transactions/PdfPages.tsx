'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { createLogger } from '@/lib/logger';
import type { PdfHandle } from '@/lib/attachment-preview/pdf-engine';

const logger = createLogger('PdfPages');

/**
 * Every page of a PDF, drawn top to bottom into one canvas each.
 *
 * This is the only place the pdf.js engine is loaded from, and it is loaded
 * lazily inside an effect: the engine is a separate chunk plus a vendored
 * worker, fetched the first time somebody previews a PDF and never before.
 *
 * Pages are drawn at the width of the container, re-drawn when it resizes,
 * and sequentially rather than all at once so the first page appears while
 * the rest are still rasterising. The document is destroyed, and any render
 * in flight cancelled, on unmount or when the bytes change.
 */
export function PdfPages({ bytes, label }: { bytes: ArrayBuffer; label: string }) {
  const t = useTranslations('attachments');
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const handleRef = useRef<PdfHandle | null>(null);
  // Both are keyed to the bytes they describe, so a new document shows the
  // loading state on the render it arrives, without a reset in an effect.
  const [opened, setOpened] = useState<{
    bytes: ArrayBuffer;
    pageCount: number;
  } | null>(null);
  const [failure, setFailure] = useState<ArrayBuffer | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  const pageCount = opened?.bytes === bytes ? opened.pageCount : null;
  const failed = failure === bytes;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { openPdf } = await import('@/lib/attachment-preview/pdf-engine');
        const handle = await openPdf(bytes);
        if (cancelled) {
          void handle.destroy();
          return;
        }
        handleRef.current = handle;
        setOpened({ bytes, pageCount: handle.numPages });
      } catch (error) {
        if (cancelled) return;
        logger.error('Failed to open PDF:', error);
        setFailure(bytes);
      }
    })();
    return () => {
      cancelled = true;
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle) void handle.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || pageCount === null || width === null) return;
    let cancelled = false;
    let current: ReturnType<PdfHandle['renderPage']> | null = null;
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
    (async () => {
      for (let page = 1; page <= pageCount; page++) {
        if (cancelled) return;
        const canvas = canvasRefs.current[page - 1];
        if (!canvas) continue;
        current = handle.renderPage(page, canvas, width, ratio);
        try {
          await current.done;
        } catch (error) {
          if (cancelled) return;
          logger.error(`Failed to render PDF page ${page}:`, error);
          setFailure(bytes);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
      current?.cancel();
    };
  }, [bytes, pageCount, width]);

  return (
    <div ref={containerRef} className="w-full">
      {failed ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {t('preview.failed')}
        </div>
      ) : pageCount === null ? (
        <LoadingSpinner text={t('preview.loading')} />
      ) : (
        <>
          <p className="mb-2 text-center text-xs text-gray-500 dark:text-gray-400">
            {t('preview.pageCount', { count: pageCount })}
          </p>
          {Array.from({ length: pageCount }, (_, index) => (
            <canvas
              key={index}
              ref={(element) => {
                canvasRefs.current[index] = element;
              }}
              role="img"
              aria-label={t('preview.page', {
                page: index + 1,
                total: pageCount,
              })}
              title={label}
              className="mx-auto mb-3 block max-w-full bg-white shadow"
            />
          ))}
        </>
      )}
    </div>
  );
}
