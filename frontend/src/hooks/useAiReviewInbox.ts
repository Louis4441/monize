'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { aiApi } from '@/lib/ai';
import { aiReviewApi } from '@/lib/ai-review-api';
import { notifyAiAction } from '@/lib/aiActionSignal';
import { clearAllCache } from '@/lib/apiCache';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { PendingAction } from '@/types/ai';
import type { AiReviewFilter, AiReviewItem } from '@/types/ai-review';

const logger = createLogger('AiReviewInbox');

/** What the approval of one proposal is doing, kept beside the list, not in it. */
export interface ProposalCardState {
  status: 'confirming' | 'confirmed' | 'error';
  errorMessage?: string;
  resultId?: string;
}

const isConflict = (error: unknown) => error instanceof AxiosError && error.response?.status === 409;

/**
 * The inbox's data and its two writes. `items === null` means not loaded (or
 * loading a new filter); it never stands in for an empty list, and a failed
 * load is `loadFailed`, never `[]`.
 */
export function useAiReviewInbox() {
  const t = useTranslations('aiReview');
  const [filter, setFilterState] = useState<AiReviewFilter>('open');
  const [items, setItems] = useState<AiReviewItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [cards, setCards] = useState<Record<string, ProposalCardState>>({});
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set());
  // Only the newest request may write the list.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const data = await aiReviewApi.list(filter);
      if (request !== latestLoad.current) return;
      setItems(data);
      setLoadFailed(false);
    } catch (error) {
      if (request !== latestLoad.current) return;
      // A list that could not be refreshed is not shown as if it were current.
      setItems(null);
      setLoadFailed(true);
      logger.error(error);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new filter is a new list: the previous one must not stay actionable.
  const setFilter = (next: AiReviewFilter) => {
    if (next === filter) return;
    setItems(null);
    setLoadFailed(false);
    setCards({});
    setFilterState(next);
  };

  const retry = () => {
    setItems(null);
    setLoadFailed(false);
    void load();
  };

  const patchCard = (id: string, card: ProposalCardState | null) =>
    setCards((prev) => {
      const rest = Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id));
      return card ? { ...rest, [id]: card } : rest;
    });

  const reloadAfterConflict = async () => {
    toast.error(t('toasts.changed'));
    setCards({});
    await load();
  };

  /** Commits the stored pending action through the chat's own confirm client. */
  const approve = async (item: AiReviewItem, action: Omit<PendingAction, 'status'>) => {
    patchCard(item.id, { status: 'confirming' });
    try {
      const res = await aiApi.confirmAction({
        actionId: action.actionId,
        signature: action.signature,
        descriptor: action.descriptor,
      });
      // The write landed: drop every cached read the edit may have changed
      // and tell mounted list pages, exactly as the chat's confirm does.
      clearAllCache();
      notifyAiAction();
      patchCard(item.id, { status: 'confirmed', resultId: res.id });
      setItems((prev) => prev && prev.map((i) => (i.id === item.id ? { ...i, status: 'applied' } : i)));
      toast.success(t('toasts.approved'));
    } catch (error) {
      if (isConflict(error)) {
        await reloadAfterConflict();
        return;
      }
      logger.error(error);
      patchCard(item.id, { status: 'error', errorMessage: getErrorMessage(error, t('toasts.approveFailed')) });
    }
  };

  const dismiss = async (item: AiReviewItem) => {
    setDismissing((prev) => new Set(prev).add(item.id));
    try {
      await aiReviewApi.dismiss(item.id);
      toast.success(t('toasts.dismissed'));
      await load();
    } catch (error) {
      if (isConflict(error)) {
        await reloadAfterConflict();
      } else {
        toast.error(getErrorMessage(error, t('toasts.dismissFailed')));
        logger.error(error);
      }
    } finally {
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  return { filter, setFilter, items, loadFailed, retry, cards, dismissing, approve, dismiss };
}
