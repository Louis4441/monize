'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon, InboxIcon } from '@heroicons/react/24/outline';
import { AiReviewRow } from '@/components/ai-review/AiReviewRow';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { TABLE_BODY_CLASS, TABLE_CLASS, Th } from '@/components/ui/Table';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { useAiReviewInbox } from '@/hooks/useAiReviewInbox';
import { AI_REVIEW_STATUSES, type AiReviewFilter, type AiReviewItem } from '@/types/ai-review';

const FILTERS: readonly AiReviewFilter[] = ['open', ...AI_REVIEW_STATUSES];

/**
 * The review inbox: the requests rules (and, later, the user) have queued for
 * an AI, filtered by status. `items === null` is loading or failed, never an
 * empty list; only a loaded, empty answer shows the explanation.
 */
export function AiReviewInbox() {
  const t = useTranslations('aiReview');
  const { filter, setFilter, items, loadFailed, retry, cards, dismissing, approve, dismiss } = useAiReviewInbox();
  const [dismissTarget, setDismissTarget] = useState<AiReviewItem | null>(null);

  const confirmDismiss = () => {
    const target = dismissTarget;
    setDismissTarget(null);
    if (target) void dismiss(target);
  };

  let body;
  if (items === null && loadFailed) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={<Button onClick={retry}>{t('error.retry')}</Button>}
        />
      </div>
    );
  } else if (items === null) {
    body = <LoadingSpinner text={t('loading')} />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        icon={<InboxIcon />}
        title={filter === 'open' ? t('empty.title') : t('empty.filteredTitle')}
        description={filter === 'open' ? t('empty.body') : t('empty.filteredBody')}
      />
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th className="px-2 sm:px-4">{t('columns.date')}</Th>
              <Th className="px-2 sm:px-4">{t('columns.request')}</Th>
              <Th align="right" className="px-2 sm:px-4">
                {t('columns.amount')}
              </Th>
              <Th className="px-2 sm:px-4">{t('columns.status')}</Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {items.map((item) => (
              <AiReviewRow
                key={item.id}
                item={item}
                card={cards[item.id]}
                dismissing={dismissing.has(item.id)}
                onApprove={approve}
                onDismiss={setDismissTarget}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-4" {...tourAnchor(TOUR_ANCHORS.aiReviewInbox)}>
      <div role="group" aria-label={t('filter.label')} className={`${SEGMENTED_GROUP_CLASS} max-w-full flex-wrap`}>
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
            className={segmentClass(filter === option)}
          >
            {t(`filter.${option}`)}
          </button>
        ))}
      </div>
      <Card>{body}</Card>
      <ConfirmDialog
        isOpen={dismissTarget !== null}
        title={t('dismissDialog.title')}
        message={t('dismissDialog.message')}
        confirmLabel={t('dismissDialog.confirm')}
        variant="warning"
        onConfirm={confirmDismiss}
        onCancel={() => setDismissTarget(null)}
      />
    </div>
  );
}
