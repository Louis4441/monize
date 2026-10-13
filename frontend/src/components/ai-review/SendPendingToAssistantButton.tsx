'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { stageChatHandoff } from '@/lib/ai-chat-handoff';
import { assistantCanAnswerNow } from '@/lib/assistant-ready';
import type { AiReviewItem } from '@/types/ai-review';

/**
 * Hands the pending requests to the assistant in the chat: it stages a prompt
 * that asks the assistant to work them with the `ai_review_requests` tool and
 * opens the chat page. The same hand-off the receipts page uses: the prompt is
 * staged on the composer and the user still presses Send (INV-SHARE-002).
 * Nothing is applied by the assistant; its proposals come back here to approve.
 */
export function SendPendingToAssistantButton({ items }: { items: readonly AiReviewItem[] | null }) {
  const t = useTranslations('aiReview.sendToAssistant');
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const pending = (items ?? []).filter((item) => item.status === 'pending').length;
  if (pending === 0) return null;

  const send = async () => {
    setChecking(true);
    try {
      // A chat that cannot answer (no provider, or a relay agent not connected)
      // would only fail; the requests keep waiting here instead.
      if (!(await assistantCanAnswerNow())) {
        toast.error(t('unavailable'));
        return;
      }
      const id = stageChatHandoff({ files: [], draft: t('prompt') });
      toast.success(t('opened'));
      router.push(`/ai?handoff=${id}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={() => void send()} isLoading={checking} disabled={checking}>
      {t('button', { count: pending })}
    </Button>
  );
}
