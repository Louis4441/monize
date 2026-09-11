'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useClickOutside } from '@/hooks/useClickOutside';
import { cn } from '@/lib/utils';

interface ExportDropdownBaseProps {
  disabled?: boolean;
  /**
   * Extra classes for the trigger button, for a caller that has to size it --
   * a toolbar standing it beside labelled fields needs `h-full`, and the
   * button's own padding cannot know that. Layout only; the colours, the
   * spacing and the disabled treatment stay here so every export button reads
   * the same.
   */
  className?: string;
  /**
   * Extra classes for the positioning wrapper the CSV+PDF variant renders --
   * the box a toolbar lays out, which is `inline-block` and therefore as wide
   * as the button's text whatever the button itself is told. A toolbar giving
   * the export its own full line on a phone (`w-full sm:w-auto`) has to size
   * this, not only the trigger. Ignored by the single-format variants, which
   * have no wrapper: there the button IS the box, so `className` sizes it.
   */
  containerClassName?: string;
}

/**
 * At least one format, in one of three shapes: both (a dropdown), PDF alone or
 * CSV alone (a single button each). A component with neither handler would
 * render a button that exports nothing, so the union refuses it at the type
 * level rather than at runtime.
 */
type ExportDropdownProps = ExportDropdownBaseProps &
  (
    | { onExportPdf: () => void; onExportCsv?: () => void }
    | { onExportPdf?: undefined; onExportCsv: () => void }
  );

export function ExportDropdown({
  onExportCsv,
  onExportPdf,
  disabled,
  className,
  containerClassName,
}: ExportDropdownProps) {
  const t = useTranslations('common');
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useClickOutside(dropdownRef, close, { enabled: isOpen });

  const handleExportCsv = () => {
    close();
    onExportCsv?.();
  };

  const handleExportPdf = async () => {
    close();
    if (!onExportPdf) return;
    setIsExporting(true);
    try {
      await onExportPdf();
    } catch (error) {
      console.error('PDF export failed:', error);
      toast.error(t('exportDropdown.failedPdf'));
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * CSV-only mode: one button, the same shape the PDF-only one has.
   *
   * A report whose current view has nothing to draw (a matrix of figures, a
   * custom report's rows) exports CSV and nothing else, and used to hand-roll
   * this button -- a third copy of the styling, and one that missed the phone
   * layout `ReportToolbarActions` gives the other two. Writing to a file is
   * synchronous here, so there is no `isExporting` state to show: the PDF path
   * has one because it renders the DOM to an image first.
   */
  if (!onExportPdf) {
    return (
      <button
        onClick={handleExportCsv}
        disabled={disabled}
        className={cn(
          'px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed',
          className,
        )}
        title={t('exportDropdown.exportCsv')}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {t('exportDropdown.exportCsv')}
      </button>
    );
  }

  // PDF-only mode: render a single button instead of a dropdown
  if (!onExportCsv) {
    return (
      <button
        onClick={handleExportPdf}
        disabled={disabled || isExporting}
        className={cn(
          'px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50',
          className,
        )}
        title={t('exportDropdown.exportPdf')}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {isExporting ? t('exportDropdown.exporting') : t('exportDropdown.exportPdf')}
      </button>
    );
  }

  return (
    <div ref={dropdownRef} className={cn('relative inline-block', containerClassName)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled || isExporting}
        className={cn(
          'px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50',
          className,
        )}
        title={t('exportDropdown.exportReport')}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {isExporting ? t('exportDropdown.exporting') : t('exportDropdown.export')}
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-36 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50">
          <button
            onClick={handleExportCsv}
            className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-t-md flex items-center gap-2"
          >
            <svg className="h-4 w-4 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            CSV
          </button>
          <button
            onClick={handleExportPdf}
            className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-b-md flex items-center gap-2"
          >
            <svg className="h-4 w-4 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            PDF
          </button>
        </div>
      )}
    </div>
  );
}
