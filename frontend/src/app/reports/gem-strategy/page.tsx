'use client';

import { PageLayout } from '@/components/layout/PageLayout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { GemStrategyReport } from '@/components/strategies/GemStrategyReport';

/**
 * GEM strategy report. A dedicated route rather than an entry in the generic
 * `[reportId]` renderer because the page carries its own header (breadcrumb,
 * cadence block) and tab bar instead of the shared report chrome.
 */
export default function GemStrategyPage() {
  return (
    <ProtectedRoute>
      <PageLayout>
        <GemStrategyReport />
      </PageLayout>
    </ProtectedRoute>
  );
}
