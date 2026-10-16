'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { DraftBlock } from '@/lib/email-receipts-format';
import { PARSER_DRAFT_MAX_RECEIPTS } from '@/types/email-receipts';

interface ReceiptBulkBarProps {
  /** Emails the selection holds: the ticked rows, or every email matching the filter. */
  count: number;
  /** The selection is "every email matching the filter", not the ticked rows. */
  allMatching: boolean;
  /** Rows on the page. */
  pageCount: number;
  /** How many emails match the filter, as the server counts them; null while unknown or failed. */
  matchingTotal: number | null;
  /** Every row of the page is ticked and more emails match the filter. */
  canSelectAllMatching: boolean;
  /** Why the draft button is off, or null when it is on. */
  draftBlock: DraftBlock | null;
  /** The sender domains of the selection, for the "different senders" reason. */
  senderDomains: readonly string[];
  /** A command is running: nothing in the bar can be pressed. */
  busy: boolean;
  drafting: boolean;
  onSelectAllMatching: () => void;
  onDelete: () => void;
  onIgnore: () => void;
  onDraft: () => void;
  onClear: () => void;
}

/**
 * The bar over the list while emails are selected: how many, the commands on
 * them (Delete, Ignore, Prepare a profile with AI) and, Gmail style, the offer to
 * widen a full page to every email matching the filter. The draft button is on
 * only for one to five emails of one sender; when it is off, a line beside it says
 * why and the button points at that line.
 */
export function ReceiptBulkBar({
  count,
  allMatching,
  pageCount,
  matchingTotal,
  canSelectAllMatching,
  draftBlock,
  senderDomains,
  busy,
  drafting,
  onSelectAllMatching,
  onDelete,
  onIgnore,
  onDraft,
  onClear,
}: ReceiptBulkBarProps) {
  const t = useTranslations('emailReceipts.receipts.selection');
  const { formatNumber } = useNumberFormat();
  const reasonId = useId();
  const disabled = busy || drafting;
  const shown = formatNumber(count, 0);

  return (
    <div
      role="region"
      aria-label={t('label')}
      className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-900/20 dark:text-blue-100"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span>{t('count', { count })}</span>
        <Button variant="danger" disabled={disabled} onClick={onDelete}>
          {t('deleteButton', { count: shown })}
        </Button>
        <Button variant="outline" disabled={disabled} onClick={onIgnore}>
          {t('ignoreButton', { count: shown })}
        </Button>
        <Button
          isLoading={drafting}
          disabled={disabled || draftBlock !== null}
          aria-describedby={draftBlock !== null ? reasonId : undefined}
          onClick={onDraft}
        >
          {t('draftButton', { count: shown })}
        </Button>
        <Button variant="outline" disabled={disabled} onClick={onClear}>
          {t('clear')}
        </Button>
      </div>
      {canSelectAllMatching && matchingTotal !== null && (
        <p>
          {t('pageSelected', { count: formatNumber(pageCount, 0) })}{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={onSelectAllMatching}
            className="font-medium text-blue-700 underline hover:no-underline focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:text-blue-300"
          >
            {t('selectAllMatching', { total: formatNumber(matchingTotal, 0) })}
          </button>
        </p>
      )}
      {allMatching && <p>{t('allMatchingSelected', { total: formatNumber(count, 0) })}</p>}
      {draftBlock !== null && (
        <p id={reasonId} className="text-amber-800 dark:text-amber-200">
          {t(`draftBlocked.${draftBlock}`, { max: PARSER_DRAFT_MAX_RECEIPTS, domains: senderDomains.join(', ') })}
        </p>
      )}
    </div>
  );
}
