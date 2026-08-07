'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { BackToReportsLink } from '@/components/reports/BackToReportsLink';
import { ReportSwitcher } from '@/components/reports/ReportSwitcher';

interface ReportDetailHeaderProps {
  /**
   * The report on screen, in the id form the Reports page uses -- which is also
   * its route: `tax-summary`, `custom/<uuid>`, `investment/<uuid>`.
   */
  reportId: string;
  title: string;
  subtitle?: string;
  /** Actions on this report (edit, export); the way back is not one of them. */
  actions?: ReactNode;
}

/**
 * The identity block for a single report: the way back to the list above the
 * title, and a caret beside it that jumps to another report. Built-in reports,
 * custom reports and investment reports all render this, so the three read as
 * one section rather than three pages that happen to share a URL prefix.
 */
export function ReportDetailHeader({
  reportId,
  title,
  subtitle,
  actions,
}: ReportDetailHeaderProps) {
  const router = useRouter();

  return (
    <div className="mb-6">
      <BackToReportsLink />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1">
            <h1 className="truncate text-2xl font-bold text-gray-900 dark:text-gray-100">
              {title}
            </h1>
            <ReportSwitcher
              currentId={reportId}
              onSelect={(id) => router.push(`/reports/${id}`)}
            />
          </div>
          {subtitle && (
            <p className="text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
        </div>

        {actions && (
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
        )}
      </div>
    </div>
  );
}
